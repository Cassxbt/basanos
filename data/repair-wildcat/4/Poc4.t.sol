// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';

// Attempts to reproduce: after an older batch expires unpaid and the borrower repays (idle assets),
// a newer batch is paid first and the older batch stays unpaid although it could have been closed.
contract Poc4 is BaseMarketTest {
  function setUp() public override {
    parameters.annualInterestBips = 0;
    parameters.delinquencyFeeBips = 0;
    parameters.protocolFeeBips = 0;
    setUpContracts(false);
  }

  // Alice and Bob hold 5e18 each; 8e18 is borrowed; Alice queues a full withdrawal that is only
  // partly paid (2e18 of 5e18), her batch expires unpaid and is moved to the unpaid queue.
  function _expiredUnpaidBatch() internal returns (uint32 aliceExpiry) {
    _deposit(alice, 5e18);
    _deposit(bob, 5e18);
    vm.prank(borrower);
    market.borrow(8e18);

    vm.prank(alice);
    aliceExpiry = market.queueFullWithdrawal();
    WithdrawalBatch memory a = market.getWithdrawalBatch(aliceExpiry);
    assertEq(a.scaledTotalAmount, 5e18);
    assertEq(a.normalizedAmountPaid, 2e18, 'only the 2e18 reserve could be paid');

    fastForward(DefaultWithdrawalBatchDuration + 1);
    market.updateState();
    assertEq(market.getUnpaidBatchExpiries().length, 1, 'alice batch is in the unpaid queue');
  }

  function _repay(uint256 amount) internal {
    asset.mint(borrower, amount);
    vm.startPrank(borrower);
    asset.approve(address(market), amount);
    market.repay(amount);
    vm.stopPrank();
  }

  function _log(string memory label, uint32 aliceExpiry, uint32 bobExpiry) internal {
    WithdrawalBatch memory a = market.getWithdrawalBatch(aliceExpiry);
    WithdrawalBatch memory b = market.getWithdrawalBatch(bobExpiry);
    emit log(label);
    emit log_named_uint('  market assets', market.totalAssets());
    emit log_named_uint('  alice batch: paid', a.normalizedAmountPaid);
    emit log_named_uint('  alice batch: still owed', a.scaledTotalAmount - a.scaledAmountBurned);
    emit log_named_uint('  bob batch: paid', b.normalizedAmountPaid);
  }

  // Repayment smaller than what the older batch is owed: the newer batch gets nothing.
  function test_poc4_repayBelowOlderDebt_newBatchGetsNothing() external {
    uint32 aliceExpiry = _expiredUnpaidBatch();
    _repay(1e18);
    assertEq(market.totalAssets(), 3e18);

    vm.prank(bob);
    uint32 bobExpiry = market.queueFullWithdrawal();
    _log('repay 1e18 (< 3e18 owed to alice), then bob queues', aliceExpiry, bobExpiry);

    assertEq(market.getWithdrawalBatch(bobExpiry).normalizedAmountPaid, 0, 'newer batch not paid');
    assertEq(market.getWithdrawalBatch(aliceExpiry).normalizedAmountPaid, 2e18);

    // The idle 1e18 goes to the older batch when it is processed.
    market.repayAndProcessUnpaidWithdrawalBatches(0, 1);
    assertEq(market.getWithdrawalBatch(aliceExpiry).normalizedAmountPaid, 3e18, 'older batch takes the idle assets');
    assertEq(market.getWithdrawalBatch(bobExpiry).normalizedAmountPaid, 0);
  }

  // Repayment larger than the older batch is owed: the newer batch only receives the excess, and the
  // assets needed to close the older batch stay reserved, so it can still be closed in full.
  function test_poc4_repayAboveOlderDebt_newBatchGetsOnlyExcess() external {
    uint32 aliceExpiry = _expiredUnpaidBatch();
    _repay(4e18);
    assertEq(market.totalAssets(), 6e18);

    vm.prank(bob);
    uint32 bobExpiry = market.queueFullWithdrawal();
    _log('repay 4e18 (> 3e18 owed to alice), then bob queues', aliceExpiry, bobExpiry);

    assertEq(market.getWithdrawalBatch(bobExpiry).normalizedAmountPaid, 1e18, 'newer batch gets only the excess');
    // The older batch is still unpaid on chain at this instant, but the assets to close it are in the market
    // and are not available to the newer batch.
    assertEq(market.getWithdrawalBatch(aliceExpiry).normalizedAmountPaid, 2e18);
    uint256 unclaimed = market.previousState().normalizedUnclaimedWithdrawals;
    assertEq(market.totalAssets() - unclaimed, 3e18, 'idle assets equal exactly what alice is still owed');

    market.repayAndProcessUnpaidWithdrawalBatches(0, 1);
    assertEq(market.getWithdrawalBatch(aliceExpiry).normalizedAmountPaid, 5e18, 'older batch closed in full');
    assertEq(market.getUnpaidBatchExpiries().length, 0);

    vm.prank(alice);
    assertEq(market.executeWithdrawal(alice, aliceExpiry), 5e18, 'alice receives her full 5e18');
  }

  // For any repayment, the older batch ends up paid min(owed, 2e18 + repayment): the newer batch's
  // payment never reduces what the older batch can receive.
  function testFuzz_poc4_olderBatchNeverShortChanged(uint256 repayAmount) external {
    repayAmount = bound(repayAmount, 1, 20e18);
    uint32 aliceExpiry = _expiredUnpaidBatch();
    _repay(repayAmount);

    vm.prank(bob);
    uint32 bobExpiry = market.queueFullWithdrawal();
    market.repayAndProcessUnpaidWithdrawalBatches(0, 1);

    uint256 expectedAlice = 2e18 + repayAmount > 5e18 ? 5e18 : 2e18 + repayAmount;
    assertEq(market.getWithdrawalBatch(aliceExpiry).normalizedAmountPaid, expectedAlice, 'older batch paid first');
    uint256 bobPaid = market.getWithdrawalBatch(bobExpiry).normalizedAmountPaid;
    uint256 expectedBob = 2e18 + repayAmount > 5e18 ? 2e18 + repayAmount - 5e18 : 0;
    if (expectedBob > 5e18) expectedBob = 5e18;
    assertEq(bobPaid, expectedBob, 'newer batch gets only the excess');
  }
}
