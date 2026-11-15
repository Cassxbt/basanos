# No lender is able to exit even after the market is closed

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L848-L868
https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L943-L946


# Vulnerability details

## Impact
Lenders might not be able to exit even after the market is closed
## Proof of Concept
When a borrower creates a market hooked by a [fixed-term hook](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol), all lenders are prohibited from withdrawing their assets from the market before the fixed-term time has elapsed.
The borrower can close the market at any time. However, `fixedTermEndTime` of the market is not updated, preventing lenders from withdrawing their assets if `fixedTermEndTime` has not yet elapsed.

Copy below codes to [WildcatMarket.t.sol](https://github.com/code-423n4/2024-08-wildcat/blob/main/test/market/WildcatMarket.t.sol) and run forge test --match-test test_closeMarket_BeforeFixedTermExpired:
```solidity
  function test_closeMarket_BeforeFixedTermExpired() external {
    //@audit-info deploy a FixedTermLoanHooks template
    address fixedTermHookTemplate = LibStoredInitCode.deployInitCode(type(FixedTermLoanHooks).creationCode);
    hooksFactory.addHooksTemplate(
      fixedTermHookTemplate,
      'FixedTermLoanHooks',
      address(0),
      address(0),
      0,
      0
    );
    
    vm.startPrank(borrower);
    //@audit-info borrower deploy a FixedTermLoanHooks hookInstance
    address hooksInstance = hooksFactory.deployHooksInstance(fixedTermHookTemplate, '');
    DeployMarketInputs memory parameters = DeployMarketInputs({
      asset: address(asset),
      namePrefix: 'name',
      symbolPrefix: 'symbol',
      maxTotalSupply: type(uint128).max,
      annualInterestBips: 1000,
      delinquencyFeeBips: 1000,
      withdrawalBatchDuration: 10000,
      reserveRatioBips: 10000,
      delinquencyGracePeriod: 10000,
      hooks: EmptyHooksConfig.setHooksAddress(address(hooksInstance))
    });
    //@audit-info borrower deploy a market hooked by a FixedTermLoanHooks hookInstance
    address market = hooksFactory.deployMarket(
      parameters,
      abi.encode(block.timestamp + (365 days)),
      bytes32(uint(1)),
      address(0),
      0
    );
    vm.stopPrank();
    //@audit-info lenders can only withdraw their asset one year later
    assertEq(FixedTermLoanHooks(hooksInstance).getHookedMarket(market).fixedTermEndTime, block.timestamp + (365 days));
    //@audit-info alice deposit 50K asset into market
    vm.startPrank(alice);
    asset.approve(market, type(uint).max);
    WildcatMarket(market).depositUpTo(50_000e18);
    vm.stopPrank();
    //@audit-info borrower close market in advance
    vm.prank(borrower);
    WildcatMarket(market).closeMarket();
    //@audit-info the market is closed
    assertTrue(WildcatMarket(market).isClosed());
    //@audit-info however, alice can not withdraw her asset due to the unexpired fixed term.
    vm.expectRevert(FixedTermLoanHooks.WithdrawBeforeTermEnd.selector);
    vm.prank(alice);
    WildcatMarket(market).queueFullWithdrawal();
  }
```
## Tools Used
Manual review
## Recommended Mitigation Steps
When a market hooked by a fixed-term hook is closed, `fixedTermEndTime` should be set to `block.timestamp` if it has not yet elapsed:
```diff
  constructor(address _deployer, bytes memory /* args */) IHooks() {
    borrower = _deployer;
    // Allow deployer to grant roles with no expiry
    _roleProviders[_deployer] = encodeRoleProvider(
      type(uint32).max,
      _deployer,
      NotPullProviderIndex
    );
    HooksConfig optionalFlags = encodeHooksConfig({
      hooksAddress: address(0),
      useOnDeposit: true,
      useOnQueueWithdrawal: false,
      useOnExecuteWithdrawal: false,
      useOnTransfer: true,
      useOnBorrow: false,
      useOnRepay: false,
      useOnCloseMarket: false,
      useOnNukeFromOrbit: false,
      useOnSetMaxTotalSupply: false,
      useOnSetAnnualInterestAndReserveRatioBips: false,
      useOnSetProtocolFeeBips: false
    });
    HooksConfig requiredFlags = EmptyHooksConfig
      .setFlag(Bit_Enabled_SetAnnualInterestAndReserveRatioBips)
+     .setFlag(Bit_Enabled_CloseMarket);
      .setFlag(Bit_Enabled_QueueWithdrawal);
    config = encodeHooksDeploymentConfig(optionalFlags, requiredFlags);
  }
```
```diff
  function onCloseMarket(
    MarketState calldata /* state */,
    bytes calldata /* hooksData */
- ) external override {}
+ ) external override {
+   HookedMarket memory market = _hookedMarkets[msg.sender];
+   if (!market.isHooked) revert NotHookedMarket();
+   if (market.fixedTermEndTime > block.timestamp) {
+     _hookedMarkets[msg.sender].fixedTermEndTime = uint32(block.timestamp);
+   }
+ }
```


## Assessed type

Timing

## Proof of concept (executed against the audited commit)

Test file `test/repair/Poc52.t.sol`, run with `forge test --match-path test/repair/Poc52.t.sol -vv` against the unmodified audited code (real `HooksFactory`, `WildcatMarket` and `FixedTermLoanHooks`, reusing the repo's `BaseMarketTest`). A market is deployed with a one-year `fixedTermEndTime`, alice deposits 50,000 tokens, 100 days pass (interest accrues), and the borrower funds the debt and calls `closeMarket()`.

What the tests show:
- `test_closedMarket_lenderCannotWithdrawBeforeTermEnd`: after `closeMarket()` the hooks' `fixedTermEndTime` is unchanged and alice's `queueFullWithdrawal()` reverts with `WithdrawBeforeTermEnd`; the remaining lock after a day-100 close is 265 days.
- `test_closedMarket_noInterestWhileLocked`: the closed market is fully backed (`totalAssets == totalDebts`), its APR is zero, and alice's balance is flat over a further 200 days of lock, so she holds an idle balance and still cannot exit.
- `test_closedMarket_lenderExitsAtTermEnd`: the delay is bounded; at `fixedTermEndTime` alice queues, executes and receives her full balance as of close.
- `test_onlyBorrowerCanReleaseLockEarly`: alice cannot lower the term (`CallerNotBorrower`); the borrower can call `setFixedTermEndTime(market, now)` even after closing, after which alice exits with her full balance. So the lock after an early close is a time-limited delay that only the borrower can shorten, not a permanent loss of funds.

### Test code

```solidity
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
```

### forge output

```
Warning: Found unknown `fuzz_runs` config for profile `coverage` defined in foundry.toml.
No files changed, compilation skipped
error: unresolved symbol `locals`
   --> src/spherex/SphereXProtectedRegisteredBase.sol:153:39
    |
153 |   ) internal returnsIfNotActivatedPre(locals) returns (ModifierLocals memory locals) {
    |                                       ^^^^^^


Ran 4 tests for test/repair/Poc52.t.sol:Poc52Test
[PASS] test_closedMarket_lenderCannotWithdrawBeforeTermEnd() (gas: 148911)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_closedMarket_lenderExitsAtTermEnd() (gas: 280799)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_closedMarket_noInterestWhileLocked() (gas: 178018)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_onlyBorrowerCanReleaseLockEarly() (gas: 285287)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

Suite result: ok. 4 passed; 0 failed; 0 skipped; finished in 6.30ms (2.80ms CPU time)

Ran 1 test suite in 158.34ms (6.30ms CPU time): 4 tests passed, 0 failed, 0 skipped (4 total tests)
```

## Response to the pre-screen checklist

1. Evidence that early closure is intended to let lenders withdraw despite an unexpired fixed term: I did not find any. The in-repo `docs/hooks/templates/Fixed Term Loan Hooks.md` says the borrower defines a timestamp before which the market is a "closed term" loan "where withdrawals are disallowed" and that this time "can be reduced but can not be set to a later date" (it does not mention `closeMarket`), `docs/hooks/How Hooks Work.md` lists `onCloseMarket` as a hook that `FixedTermLoanHooks` implements as a no-op, and `README.md` says borrowers "can terminate/close markets at will". The tests establish the behaviour (lock survives closure, lasting up to the remaining term) but not that it contradicts a documented expectation; that part is an argument from the protocol's purpose, not from a cited policy clause.
2. Practical severity of the time-limited delay (strengthens): measured by the tests. The lock after closure equals the remaining term (265 days in the test, bounded above by the one-year maximum term enforced in `_onCreateMarket`), the closed market is fully backed, no interest accrues during the lock, funds are fully recoverable at term end (`test_closedMarket_lenderExitsAtTermEnd`), and the borrower, but not the lender, can end the lock immediately via `setFixedTermEndTime`. No loss of principal is shown.
