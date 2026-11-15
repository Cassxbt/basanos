// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import { FixedTermLoanHooks } from 'src/access/FixedTermLoanHooks.sol';

contract Poc52Test is BaseMarketTest {
  uint256 internal constant TERM = 365 days; // MaximumLoanTerm

  FixedTermLoanHooks internal ftHooks;
  WildcatMarket internal ftMarket;
  uint256 internal termEnd;

  function setUp() public override {
    super.setUp();

    address template = LibStoredInitCode.deployInitCode(type(FixedTermLoanHooks).creationCode);
    hooksFactory.addHooksTemplate(template, 'FixedTermLoanHooks', address(0), address(0), 0, 0);

    termEnd = block.timestamp + TERM;
    vm.startPrank(borrower);
    ftHooks = FixedTermLoanHooks(hooksFactory.deployHooksInstance(template, ''));
    DeployMarketInputs memory inputs = DeployMarketInputs({
      asset: address(asset),
      namePrefix: 'name',
      symbolPrefix: 'symbol',
      maxTotalSupply: type(uint128).max,
      annualInterestBips: 1000,
      delinquencyFeeBips: 1000,
      withdrawalBatchDuration: 10000,
      reserveRatioBips: 10000,
      delinquencyGracePeriod: 10000,
      hooks: EmptyHooksConfig.setHooksAddress(address(ftHooks))
    });
    ftMarket = WildcatMarket(
      hooksFactory.deployMarket(inputs, abi.encode(termEnd), bytes32(uint(1)), address(0), 0)
    );
    vm.stopPrank();
    assertEq(ftHooks.getHookedMarket(address(ftMarket)).fixedTermEndTime, termEnd);

    vm.startPrank(alice);
    asset.approve(address(ftMarket), type(uint256).max);
    ftMarket.depositUpTo(50_000e18);
    vm.stopPrank();
  }

  function _closeAfter(uint256 secondsUntilClose) internal {
    vm.warp(block.timestamp + secondsUntilClose);
    uint256 owed = ftMarket.totalDebts() - ftMarket.totalAssets();
    asset.mint(borrower, owed);
    vm.startPrank(borrower);
    asset.approve(address(ftMarket), owed);
    ftMarket.closeMarket();
    vm.stopPrank();
    assertTrue(ftMarket.isClosed());
  }

  // Claim: after the borrower closes early, lenders still cannot exit until the original term end.
  function test_closedMarket_lenderCannotWithdrawBeforeTermEnd() external {
    _closeAfter(100 days);
    assertEq(ftHooks.getHookedMarket(address(ftMarket)).fixedTermEndTime, termEnd, 'term untouched by closeMarket');

    uint256 remaining = termEnd - block.timestamp;
    assertEq(remaining, 265 days, 'remaining lock after an early close on day 100');

    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    ftMarket.queueFullWithdrawal();
  }

  // Consequence during the lock: no interest accrues (APR is zeroed on close) and the funds are fully
  // backed in the market, so the lender holds an idle, fully collateralised balance.
  function test_closedMarket_noInterestWhileLocked() external {
    _closeAfter(100 days);
    uint256 balanceAtClose = ftMarket.balanceOf(alice);
    assertEq(ftMarket.totalAssets(), ftMarket.totalDebts(), 'market fully backed');

    vm.warp(block.timestamp + 200 days);
    assertEq(ftMarket.balanceOf(alice), balanceAtClose, 'balance flat for 200 days of lock');
    assertEq(ftMarket.currentState().annualInterestBips, 0);
    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    ftMarket.queueFullWithdrawal();
  }

  // The delay is bounded: the lock ends at the original term end and the lender recovers everything.
  function test_closedMarket_lenderExitsAtTermEnd() external {
    _closeAfter(100 days);
    uint256 balanceAtClose = ftMarket.balanceOf(alice);

    vm.warp(termEnd);
    vm.prank(alice);
    uint32 expiry = ftMarket.queueFullWithdrawal();
    uint256 before = asset.balanceOf(alice);
    ftMarket.executeWithdrawal(alice, expiry);
    assertEq(asset.balanceOf(alice) - before, balanceAtClose, 'full balance recovered at term end');
  }

  // Only the borrower can release the lock early (it can only be reduced), after closing or not.
  function test_onlyBorrowerCanReleaseLockEarly() external {
    _closeAfter(100 days);
    uint256 balanceAtClose = ftMarket.balanceOf(alice);

    vm.prank(alice);
    vm.expectRevert(FixedTermLoanHooks.CallerNotBorrower.selector);
    ftHooks.setFixedTermEndTime(address(ftMarket), uint32(block.timestamp));

    vm.prank(borrower);
    ftHooks.setFixedTermEndTime(address(ftMarket), uint32(block.timestamp));

    vm.prank(alice);
    uint32 expiry = ftMarket.queueFullWithdrawal();
    uint256 before = asset.balanceOf(alice);
    ftMarket.executeWithdrawal(alice, expiry);
    assertEq(asset.balanceOf(alice) - before, balanceAtClose, 'exit works once the borrower lowers the term');
  }
}
