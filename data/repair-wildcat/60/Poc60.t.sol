// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import { FixedTermLoanHooks } from 'src/access/FixedTermLoanHooks.sol';

/// Real market (deployed through HooksFactory) whose hooks instance is FixedTermLoanHooks.
contract Poc60 is BaseMarketTest {
  FixedTermLoanHooks internal ftHooks;
  uint32 internal termEnd;
  uint32 internal constant batchDuration = 1 days;

  function _getHooksTemplate() internal virtual override returns (address) {
    return LibStoredInitCode.deployInitCode(type(FixedTermLoanHooks).creationCode);
  }

  function setUp() public virtual override {
    termEnd = uint32(block.timestamp + 30 days);
    startPrank(address(this));
    archController.registerBorrower(borrower);
    stopPrank();
    updateFeeConfiguration(parameters);

    startPrank(borrower);
    ftHooks = FixedTermLoanHooks(hooksFactory.deployHooksInstance(hooksTemplate, ''));
    stopPrank();

    parameters.asset = address(asset = new MockERC20('Token', 'TKN', 18));
    HooksConfig cfg = EmptyHooksConfig
      .setHooksAddress(address(ftHooks))
      .setFlag(Bit_Enabled_Deposit)
      .setFlag(Bit_Enabled_QueueWithdrawal)
      .setFlag(Bit_Enabled_SetAnnualInterestAndReserveRatioBips);
    startPrank(borrower);
    market = WildcatMarket(
      hooksFactory.deployMarket(
        DeployMarketInputs({
          asset: parameters.asset,
          namePrefix: 'Wildcat ',
          symbolPrefix: 'WC',
          maxTotalSupply: parameters.maxTotalSupply,
          annualInterestBips: 1000,
          delinquencyFeeBips: 1000,
          withdrawalBatchDuration: batchDuration,
          reserveRatioBips: 2000,
          delinquencyGracePeriod: 2000,
          hooks: cfg
        }),
        abi.encode(termEnd),
        bytes32(uint256(uint160(borrower)) << 96),
        address(0),
        0
      )
    );
    stopPrank();

    asset.mint(alice, 10e18);
    startPrank(alice);
    asset.approve(address(market), type(uint256).max);
    stopPrank();
    startPrank(borrower);
    ftHooks.grantRole(alice, uint32(block.timestamp));
    stopPrank();
  }

  function test_poc60_withdrawalOnlyQueueableAtTermEnd_paidOneBatchLater() external {
    startPrank(alice);
    market.deposit(1e18);
    stopPrank();

    // Borrower never borrows and pre-funds a buffer that covers all interest and fees through the test.
    asset.mint(borrower, 1e17);
    startPrank(borrower);
    asset.approve(address(market), 1e17);
    market.repay(1e17);
    stopPrank();

    // One second before term end: queueing is rejected.
    vm.warp(termEnd - 1);
    startPrank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    market.queueFullWithdrawal();
    stopPrank();

    // A request made one batchDuration early, whose batch would expire exactly at term end,
    // is also rejected: the hook compares block.timestamp, not the batch expiry.
    vm.warp(termEnd - batchDuration);
    startPrank(alice);
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    market.queueFullWithdrawal();
    stopPrank();

    // At term end: queueing is accepted.
    vm.warp(termEnd);
    uint256 balanceAtTermEnd = market.balanceOf(alice);
    startPrank(alice);
    market.queueFullWithdrawal();
    stopPrank();
    uint32 expiry = market.previousState().pendingWithdrawalExpiry;
    assertEq(expiry, termEnd + batchDuration, 'batch expires one batchDuration after term end');

    // Money is in the market (borrower never borrowed) but cannot be claimed until the batch expires.
    assertGe(asset.balanceOf(address(market)), balanceAtTermEnd, 'liquidity for the claim is in the market');
    startPrank(alice);
    vm.expectRevert(IMarketEventsAndErrors.WithdrawalBatchNotExpired.selector);
    market.executeWithdrawal(alice, expiry);
    stopPrank();

    // After expiry the lender is paid. With liquidity available the batch is settled at the scale
    // factor of the queue time, so the payout equals the claim at term end (no interest accrues
    // during the extra wait, and nothing is lost relative to the claim at queue time).
    vm.warp(uint256(expiry) + 1);
    startPrank(alice);
    uint256 paid = market.executeWithdrawal(alice, expiry);
    stopPrank();

    emit log_named_uint('claim value at term end (queue time)', balanceAtTermEnd);
    emit log_named_uint('amount paid at term end + batchDuration', paid);
    assertApproxEqAbs(paid, balanceAtTermEnd, 1, 'payout equals claim at queue time (1 wei rounding)');
    assertEq(block.timestamp, uint256(termEnd) + batchDuration + 1, 'cash received batchDuration after term end');
  }
}
