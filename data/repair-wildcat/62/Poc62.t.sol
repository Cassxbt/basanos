// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';

contract Poc62 is BaseMarketTest {
  using MathUtils for uint256;

  struct Outcome {
    uint256 borrowerNetPaid;
    uint256 alicePayout;
    uint256 protocolFees;
  }

  uint32 internal expiry;

  /// The finding's setup verbatim (its `parameters.annualInterestBips = 3650` line is applied after
  /// the market is deployed, so it has no effect: the market runs at the default 10% APR).
  function _scenario() internal {
    _deposit(alice, 1e18);
    _borrow(market.borrowableAssets());
    startPrank(alice);
    market.queueFullWithdrawal();
    stopPrank();
    expiry = market.previousState().pendingWithdrawalExpiry;
    fastForward(52 weeks);
    asset.mint(borrower, 10e18);
  }

  function _settle(uint256 borrowerBefore) internal returns (Outcome memory o) {
    o.borrowerNetPaid = borrowerBefore - asset.balanceOf(borrower);
    startPrank(alice);
    uint256 aliceBefore = asset.balanceOf(alice);
    market.executeWithdrawal(alice, expiry);
    o.alicePayout = asset.balanceOf(alice) - aliceBefore;
    stopPrank();
    o.protocolFees = market.accruedProtocolFees();
  }

  /// The finding's two PoC functions, unchanged except that they report the same quantity.
  function test_poc62_reproducesFindingNumbers() external {
    _scenario();
    uint256 snap = vm.snapshot();

    startPrank(borrower);
    asset.approve(address(market), 10e18);
    uint256 initBalance = asset.balanceOf(borrower);
    asset.transfer(address(market), 10e18);
    market.closeMarket();
    uint256 paidFundsFirst = initBalance - asset.balanceOf(borrower);
    stopPrank();

    vm.revertTo(snap);
    startPrank(borrower);
    asset.approve(address(market), 10e18);
    initBalance = asset.balanceOf(borrower);
    market.closeMarket();
    uint256 paidStateFirst = initBalance - asset.balanceOf(borrower);
    stopPrank();

    emit log_named_uint('paid, funds already in market (finding log 1)', paidFundsFirst);
    emit log_named_uint('paid, closeMarket pulls funds  (finding log 2)', paidStateFirst);
    assertEq(paidFundsFirst, 800455200405885337);
    assertEq(paidStateFirst, 967625143234433533);
  }

  /// From one identical pre-state, decompose where the extra payment goes and compare it with an
  /// independent calculation of the interest and penalty the market's own rates assign to the
  /// 363 days during which Alice's batch was unpaid.
  function test_poc62_extraIsAccrualOwedForElapsedTime() external {
    _scenario();
    uint256 snap = vm.snapshot();

    Outcome memory fundsFirst;
    {
      startPrank(borrower);
      uint256 before = asset.balanceOf(borrower);
      asset.transfer(address(market), 10e18);
      market.closeMarket();
      stopPrank();
      fundsFirst = _settle(before);
    }
    vm.revertTo(snap);

    Outcome memory stateFirst;
    {
      startPrank(borrower);
      uint256 before = asset.balanceOf(borrower);
      asset.approve(address(market), 10e18);
      market.closeMarket();
      stopPrank();
      stateFirst = _settle(before);
    }

    uint256 extraBorrower = stateFirst.borrowerNetPaid - fundsFirst.borrowerNetPaid;
    uint256 extraLender = stateFirst.alicePayout - fundsFirst.alicePayout;
    uint256 extraFees = stateFirst.protocolFees - fundsFirst.protocolFees;
    emit log_named_uint('borrower net paid, funds-first ', fundsFirst.borrowerNetPaid);
    emit log_named_uint('borrower net paid, state-first ', stateFirst.borrowerNetPaid);
    emit log_named_uint('lender payout,     funds-first ', fundsFirst.alicePayout);
    emit log_named_uint('lender payout,     state-first ', stateFirst.alicePayout);
    emit log_named_uint('protocol fees,     funds-first ', fundsFirst.protocolFees);
    emit log_named_uint('protocol fees,     state-first ', stateFirst.protocolFees);
    emit log_named_uint('extra borrower cost            ', extraBorrower);
    emit log_named_uint('extra to lender                ', extraLender);
    emit log_named_uint('extra to protocol fees         ', extraFees);

    // Every extra unit the borrower pays reaches the lender or the fee recipient (no deadweight loss).
    assertApproxEqAbs(extraBorrower, extraLender + extraFees, 2);
  }

  /// Reference path: the borrower repays right after the batch expires (before any late accrual
  /// exists) and closes 52 weeks later. The lender payout equals the "funds-first" payout, i.e. the
  /// funds-first ordering lets a repayment made 52 weeks late be priced as if it were made on time.
  function test_poc62_fundsFirstPriceEqualsOnTimeRepayment() external {
    uint256 snap = vm.snapshot();
    _scenario();
    startPrank(borrower);
    uint256 before = asset.balanceOf(borrower);
    asset.transfer(address(market), 10e18);
    market.closeMarket();
    stopPrank();
    Outcome memory lateFundsFirst = _settle(before);
    vm.revertTo(snap);

    // Same history from the same start, but with a timely repayment one second after expiry.
    _deposit(alice, 1e18);
    _borrow(market.borrowableAssets());
    startPrank(alice);
    market.queueFullWithdrawal();
    stopPrank();
    expiry = market.previousState().pendingWithdrawalExpiry;
    vm.warp(uint256(expiry) + 1);
    asset.mint(borrower, 10e18);
    startPrank(borrower);
    before = asset.balanceOf(borrower);
    asset.approve(address(market), 10e18);
    market.repay(1e18);
    stopPrank();
    fastForward(52 weeks - 1 days - 1);
    startPrank(borrower);
    market.closeMarket();
    stopPrank();
    Outcome memory onTime = _settle(before);

    emit log_named_uint('lender payout, repaid on time (expiry+1s)     ', onTime.alicePayout);
    emit log_named_uint('lender payout, funds-first, 52 weeks late     ', lateFundsFirst.alicePayout);
    assertApproxEqRel(lateFundsFirst.alicePayout, onTime.alicePayout, 1e12);
  }

  /// Independent recomputation of the state-first payout from the market's configured rates only.
  /// The borrower stays silent past batch expiry, anyone pokes the market one second after expiry
  /// (so the stored state reflects the unpaid batch), and 52 weeks after queueing the borrower closes.
  function test_poc62_stateFirstPayoutMatchesStatedRates() external {
    _deposit(alice, 1e18);
    _borrow(market.borrowableAssets());
    startPrank(alice);
    market.queueFullWithdrawal();
    stopPrank();
    expiry = market.previousState().pendingWithdrawalExpiry;
    vm.warp(uint256(expiry) + 1);
    market.updateState();
    asset.mint(borrower, 10e18);

    MarketState memory s = market.previousState();
    WithdrawalBatch memory batch = market.getWithdrawalBatch(expiry);
    uint256 unpaidScaled = batch.scaledTotalAmount - batch.scaledAmountBurned;
    assertGt(unpaidScaled, 0, 'Alice batch was left unpaid at expiry');
    assertTrue(s.isDelinquent, 'market delinquent while the batch is unpaid');
    assertGt(s.timeDelinquent, parameters.delinquencyGracePeriod, 'already past the grace period');

    fastForward(52 weeks - 1 days - 1);
    uint256 dt = block.timestamp - s.lastInterestAccruedTimestamp;
    // The market's own parameters: 10% base APR and 10% delinquency-fee APR, linear in time,
    // the whole interval being outside the 2000 s grace period.
    assertEq(s.annualInterestBips, parameters.annualInterestBips);
    assertEq(parameters.delinquencyFeeBips, 1000);
    uint256 base = uint256(parameters.annualInterestBips) * 1e23 * dt / 365 days;
    uint256 penalty = uint256(parameters.delinquencyFeeBips) * 1e23 * dt / 365 days;
    uint256 expectedScaleFactor = uint256(s.scaleFactor) + uint256(s.scaleFactor).rayMul(base + penalty);
    emit log_named_uint('seconds the batch stayed unpaid after the poke', dt);
    assertEq(market.scaleFactor(), expectedScaleFactor, 'market scale factor == independent calc');

    startPrank(borrower);
    uint256 before = asset.balanceOf(borrower);
    asset.approve(address(market), 10e18);
    market.closeMarket();
    stopPrank();
    Outcome memory o = _settle(before);

    uint256 expectedPayout = batch.normalizedAmountPaid + unpaidScaled.rayMul(expectedScaleFactor);
    emit log_named_uint('lender payout, actual                ', o.alicePayout);
    emit log_named_uint('lender payout, independent calc      ', expectedPayout);
    assertApproxEqAbs(o.alicePayout, expectedPayout, 2);

    // Counterfactual: had the claim only accrued base interest (no penalty) the payout would be lower;
    // the penalty is the delinquency fee the borrower agreed to when deploying the market.
    uint256 baseOnly = batch.normalizedAmountPaid +
      unpaidScaled.rayMul(uint256(s.scaleFactor) + uint256(s.scaleFactor).rayMul(base));
    emit log_named_uint('lender payout if no delinquency fee  ', baseOnly);
  }
}
