# `FixedTermLoanHooks` allow Borrower to update Annual Interest before end of the "Fixed Term Period"

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L857-L859
https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L960-L978


# Vulnerability details

## Summary
While the documentation states that in case of 'fixed term' market the APR cannot be changed until the term ends, nothing prevents this in `FixedTermLoanHooks`.

## Vulnerability details
In Wildcat markets, lenders know in advance how much `APR` the borrower will pay them. In order to allow lenders to exit the market swiftly, the market must always have at least a `reserve ratio` of the lender funds ready to be withdrawn.
If the borrower decide to [reduce the `APR`](https://docs.wildcat.finance/using-wildcat/day-to-day-usage/borrowers#reducing-apr), in order to allow lenders to 'ragequit', a new `reserve ratio` is calculated based on the variation of the APR as described in the link above.
Finally, is a market implement a fixed term (date until when withdrawals are not possible), it shouldn't be able to reduce the APR, as this would allow the borrower to 'rug' the lenders by reducing the APR to 0% while they couldn't do anything against that.

The issue here is that while lenders are (as expected) prevented to withdraw before end of term:
https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L857-L859
```solidity
File: src/access/FixedTermLoanHooks.sol
848:   function onQueueWithdrawal(
849:     address lender,
850:     uint32 /* expiry */,
851:     uint /* scaledAmount */,
852:     MarketState calldata /* state */,
853:     bytes calldata hooksData
854:   ) external override {
855:     HookedMarket memory market = _hookedMarkets[msg.sender];
856:     if (!market.isHooked) revert NotHookedMarket();
857:     if (market.fixedTermEndTime > block.timestamp) {
858:       revert WithdrawBeforeTermEnd();
859:     }
```

this is not the case for the borrower setting the annual interest:
https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L960-L978
```solidity
File: src/access/FixedTermLoanHooks.sol
960:   function onSetAnnualInterestAndReserveRatioBips(
961:     uint16 annualInterestBips,
962:     uint16 reserveRatioBips,
963:     MarketState calldata intermediateState,
964:     bytes calldata hooksData
965:   )
966:     public
967:     virtual
968:     override
969:     returns (uint16 updatedAnnualInterestBips, uint16 updatedReserveRatioBips)
970:   {
971:     return
972:       super.onSetAnnualInterestAndReserveRatioBips(
973:         annualInterestBips,
974:         reserveRatioBips,
975:         intermediateState,
976:         hooksData
977:       );
978:   }
979: 
```

## Impact
Borrower can rug the lenders by reducing the APR while they cannot quit the market

## Proof of Concept

Add this test to `test/access/FixedTermLoanHooks.t.sol`

```
  function testAudit_SetAnnualInterestBeforeTermEnd() external {
    DeployMarketInputs memory inputs;

	// "deploying" a market with MockFixedTermLoanHooks
	inputs.hooks = EmptyHooksConfig.setHooksAddress(address(hooks));
	hooks.onCreateMarket(
		address(this),				// deployer
		address(1),				// dummy market address
		inputs,					// ...
		abi.encode(block.timestamp + 365 days, 0) // fixedTermEndTime: 1 year, minimumDeposit: 0
	);

	vm.prank(address(1));
	MarketState memory state;
	// as the fixedTermEndTime isn't past yet, it's not possible to withdraw
	vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
	hooks.onQueueWithdrawal(address(1), 0, 1, state, '');

	// but it is still possible to reduce the APR to zero
	hooks.onSetAnnualInterestAndReserveRatioBips(0, 0, state, "");
  }
```

## Tools Used
Manual review

## Recommended Mitigation Steps

When `FixedTermLoanHooks::onSetAnnualInterestAndReserveRatioBips` is called, revert if `market.fixedTermEndTime > block.timestamp`


## Assessed type

Invalid Validation

## Proof of concept (executed against the audited commit)

Unlike the direct hook call in the report, this test deploys a real `WildcatMarket` through the `HooksFactory` using the `FixedTermLoanHooks` template with a one-year fixed term, and exercises `market.setAnnualInterestAndReserveRatioBips` and `market.queueFullWithdrawal` on it (nothing under `src/` or `lib/` was changed). It shows two things. (1) With no borrowing, the borrower cuts the APR from 10% to 0% mid-term; the temporary reserve ratio rises to 100% but is unusable by lenders because `queueFullWithdrawal` and `queueWithdrawal` still revert with `WithdrawBeforeTermEnd` before and after the cut, and the lender's balance stops growing. (2) With 70% of deposits borrowed, a deep cut to 0% is rejected with `InsufficientReservesForNewLiquidityRatio`, but staged cuts of at most 25% per two-week period are accepted (APR 1000 -> 750 -> 563 -> 423 -> 318 bips) while the lender is blocked from withdrawing at every step. The test does not show any loss of principal; the harm shown is loss of yield for lenders who cannot exit.

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import { FixedTermLoanHooks } from 'src/access/FixedTermLoanHooks.sol';

contract Poc77 is BaseMarketTest {
  uint32 internal termEnd;

  function _getHooksTemplate() internal virtual override returns (address) {
    return LibStoredInitCode.deployInitCode(type(FixedTermLoanHooks).creationCode);
  }

  // Deploys a real WildcatMarket through the HooksFactory with the FixedTermLoanHooks template
  // and a one-year fixed term (hooksData = abi.encode(fixedTermEndTime)).
  function setUp() public virtual override {
    termEnd = uint32(block.timestamp + 365 days);
    parameters.annualInterestBips = 1000;
    parameters.reserveRatioBips = 2000;

    MarketInputParameters memory inputs = parameters;
    deployHooksInstance(inputs, false);
    inputs.asset = address(asset = new MockERC20('Token', 'TKN', 18));
    updateFeeConfiguration(inputs);
    parameters = inputs;

    vm.prank(borrower);
    market = WildcatMarket(
      hooksFactory.deployMarket(
        DeployMarketInputs({
          asset: parameters.asset,
          namePrefix: parameters.namePrefix,
          symbolPrefix: parameters.symbolPrefix,
          maxTotalSupply: parameters.maxTotalSupply,
          annualInterestBips: parameters.annualInterestBips,
          delinquencyFeeBips: parameters.delinquencyFeeBips,
          withdrawalBatchDuration: parameters.withdrawalBatchDuration,
          reserveRatioBips: parameters.reserveRatioBips,
          delinquencyGracePeriod: parameters.delinquencyGracePeriod,
          hooks: parameters.hooksConfig
        }),
        abi.encode(termEnd),
        bytes32(uint256(uint160(borrower)) << 96),
        address(0),
        0
      )
    );

    vm.prank(borrower);
    hooks.grantRole(alice, uint32(block.timestamp));
    asset.mint(alice, 100e18);
    vm.prank(alice);
    asset.approve(address(market), type(uint256).max);
  }

  function _depositAndBorrow(uint256 deposit, uint256 borrowAmount) internal {
    vm.prank(alice);
    market.depositUpTo(deposit);
    if (borrowAmount > 0) {
      vm.prank(borrower);
      market.borrow(borrowAmount);
    }
  }

  function test_poc77_fixedTermAprCutToZeroWhileWithdrawalsBlocked() external {
    assertEq(FixedTermLoanHooks(address(hooks)).version(), 'FixedTermLoanHooks');
    assertEq(market.annualInterestBips(), 1000);
    _depositAndBorrow(10e18, 0);

    fastForward(30 days);

    // Lender cannot exit during the fixed term.
    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    market.queueFullWithdrawal();

    // Borrower repays the accrued interest, then cuts the APR from 10% to 0% through the real
    // market entrypoint, mid-term. The temporary reserve ratio rises to 100%, which the market
    // can satisfy because nothing was borrowed.
    uint256 owed = market.totalDebts() - market.totalAssets();
    asset.mint(borrower, owed);
    vm.startPrank(borrower);
    asset.approve(address(market), owed);
    market.repay(owed);
    vm.stopPrank();
    vm.prank(borrower);
    market.setAnnualInterestAndReserveRatioBips(0, 2000);
    assertEq(market.annualInterestBips(), 0, 'apr is now zero');
    assertLt(block.timestamp, termEnd, 'still inside the fixed term');
    emit log_named_uint('reserve ratio after cut (temporary)', market.reserveRatioBips());

    // Lender still cannot exit, so the temporary reserve ratio is not usable by lenders.
    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    market.queueFullWithdrawal();

    // Interest stops accruing for the locked lender.
    uint256 balanceBefore = market.balanceOf(alice);
    fastForward(60 days);
    assertEq(market.balanceOf(alice), balanceBefore, 'no more interest accrues');
    emit log_named_uint('alice balance (no growth over 60 days)', market.balanceOf(alice));

    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    market.queueWithdrawal(1e18);
  }

  function test_poc77_borrowedMarketStagedCuts() external {
    _depositAndBorrow(10e18, 7e18);

    uint256 apr = 1000;
    for (uint i; i < 4; i++) {
      // Deep cuts are rejected while funds are borrowed (reserve ratio would need to rise to 100%).
      if (i == 0) {
        vm.prank(borrower);
        vm.expectRevert(IMarketEventsAndErrors.InsufficientReservesForNewLiquidityRatio.selector);
        market.setAnnualInterestAndReserveRatioBips(0, 2000);
      }
      // 25% cut per two weeks keeps the reserve ratio unchanged.
      apr = (apr * 75 + 99) / 100;
      vm.prank(borrower);
      market.setAnnualInterestAndReserveRatioBips(uint16(apr), 2000);
      assertEq(market.reserveRatioBips(), 2000, 'reserve ratio unchanged for <=25% cut');
      emit log_named_uint('apr after cut', market.annualInterestBips());
      vm.prank(alice);
      vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
      market.queueFullWithdrawal();
      fastForward(2 weeks + 1);
      // Re-submitting the current APR after the two-week period expires the temporary
      // reserve ratio and re-pegs the 'original' APR to the new, lower value.
      vm.prank(borrower);
      market.setAnnualInterestAndReserveRatioBips(uint16(apr), 2000);
    }
    assertLt(block.timestamp, termEnd, 'still inside the fixed term');
    assertLt(market.annualInterestBips(), 350);
  }
}
```

Real `forge test --match-path test/repair/Poc77.t.sol -vv` output:

```
Warning: Found unknown `fuzz_runs` config for profile `coverage` defined in foundry.toml.
Compiling 1 files with Solc 0.8.25
Solc 0.8.25 finished in 1.39s
Compiler run successful!
error: unresolved symbol `locals`
   --> src/spherex/SphereXProtectedRegisteredBase.sol:153:39
    |
153 |   ) internal returnsIfNotActivatedPre(locals) returns (ModifierLocals memory locals) {
    |                                       ^^^^^^


Ran 2 tests for test/repair/Poc77.t.sol:Poc77
[PASS] test_poc77_borrowedMarketStagedCuts() (gas: 825373)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  apr after cut: 750
  apr after cut: 563
  apr after cut: 423
  apr after cut: 318

[PASS] test_poc77_fixedTermAprCutToZeroWhileWithdrawalsBlocked() (gas: 506626)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  reserve ratio after cut (temporary): 10000
  alice balance (no growth over 60 days): 10082191780821917808

Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 21.16ms (5.83ms CPU time)

Ran 1 test suite in 156.73ms (21.16ms CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)
```

## Response to the pre-screen checklist

1. Support for "APR changes must be frozen before term end": the documentation in the audited repository does not establish this. `docs/hooks/templates/Fixed Term Loan Hooks.md` says only that the borrower defines a timestamp before which withdrawals are disallowed (and that this time can be reduced but not increased); it says nothing about APR changes. `docs/Known Issues.md` lists a malicious borrower "slowly reducing the APR by 25% every two weeks to avoid the penalty of an increased reserve ratio" as a known avenue. The documentation page the report cites for ragequit behaviour is external to the repository and was not checked here, so the report's documentation premise remains unsupported by the in-repo sources; what the code does is shown in the test (no `fixedTermEndTime` check in `onSetAnnualInterestAndReserveRatioBips`, versus the check in `onQueueWithdrawal`).
2. Demonstration of lender harm: `test_poc77_fixedTermAprCutToZeroWhileWithdrawalsBlocked` shows the APR cut to 0 mid-term, the lender's `queueFullWithdrawal` and `queueWithdrawal` reverting with `WithdrawBeforeTermEnd` after the cut, and the lender's balance not growing over the next 60 days; the temporary 100% reserve ratio (shown in the log) does not help because no exit is allowed. `test_poc77_borrowedMarketStagedCuts` shows that where funds are borrowed, the reserve-ratio mechanism does block a single deep cut, but a sequence of 25% cuts passes it (as the Known Issues file anticipates) while lenders remain locked, so the reserve-ratio protection does not protect fixed-term lenders. The harm demonstrated is lost yield, not lost principal.
3. Executed reproduction through the real market (strengthens): done; the tests above deploy a real market via `HooksFactory.deployMarket` with `FixedTermLoanHooks`, call `setAnnualInterestAndReserveRatioBips` on the market, and show the withdrawal revert on the same market.
