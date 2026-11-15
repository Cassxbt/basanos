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
