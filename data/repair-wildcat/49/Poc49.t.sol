// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';
import {MockFixedTermLoanHooks} from '../shared/mocks/MockFixedTermLoanHooks.sol';
import 'src/access/IRoleProvider.sol';

/// Minimal contract provider: forwards `grantRole` calls from its operator EOA to the hooks.
contract ForwardingPushProvider is IRoleProvider {
  address public immutable operator;

  constructor(address _operator) {
    operator = _operator;
  }

  function isPullProvider() external pure override returns (bool) {
    return false;
  }

  function getCredential(address) external pure override returns (uint32) {
    return 0;
  }

  function validateCredential(address, bytes calldata) external pure override returns (uint32) {
    return 0;
  }

  function grant(AccessControlHooks hooks, address account) external {
    require(msg.sender == operator);
    hooks.grantRole(account, uint32(block.timestamp));
  }
}

contract Poc49Test is BaseMarketTest {
  address internal kycOperator = address(0x4b1c); // an EOA the borrower wants to use as a push provider
  address internal erin = address(0xe41);

  function setUp() public override {
    super.setUp();
    // erin receives market tokens (transfers do not require access), so she is not a known lender
    // and needs a credential before she can queue a withdrawal.
    vm.prank(alice);
    market.depositUpTo(10e18);
    vm.prank(alice);
    market.transfer(erin, 1e18);
    assertEq(kycOperator.code.length, 0, 'operator is an EOA');
  }

  function test_addRoleProvider_EOA_reverts_AccessControlHooks() external {
    vm.prank(borrower);
    (bool ok, bytes memory ret) = address(hooks).call(
      abi.encodeCall(AccessControlHooks.addRoleProvider, (kycOperator, 30 days))
    );
    assertFalse(ok, 'addRoleProvider(EOA) reverts');
    assertEq(ret.length, 0, 'empty revert data (extcodesize check on the isPullProvider call)');
  }

  function test_addRoleProvider_EOA_reverts_FixedTermLoanHooks() external {
    MockFixedTermLoanHooks ftHooks = new MockFixedTermLoanHooks(address(this));
    (bool ok, bytes memory ret) = address(ftHooks).call(
      abi.encodeCall(ftHooks.addRoleProvider, (kycOperator, 30 days))
    );
    assertFalse(ok);
    assertEq(ret.length, 0);
  }

  // Consequence: the EOA can never act as a push provider, so it cannot grant credentials.
  function test_unregisteredEOA_cannotGrantRole() external {
    vm.prank(kycOperator);
    vm.expectRevert(AccessControlHooks.ProviderNotFound.selector);
    hooks.grantRole(erin, uint32(block.timestamp));

    (bool ok, bytes memory ret) = _queueWithdrawal(erin);
    assertFalse(ok, 'erin cannot withdraw without a credential');
    assertEq(bytes4(ret), AccessControlHooks.NotApprovedLender.selector);
  }

  // Limit of the impact: the deployer-borrower is itself an EOA provider (registered in the
  // constructor) and can always grant, so lenders are never stuck by this alone.
  function test_borrowerEOA_isProvider_andCanUnblockLender() external {
    vm.prank(borrower);
    hooks.grantRole(erin, uint32(block.timestamp));
    (bool ok, ) = _queueWithdrawal(erin);
    assertTrue(ok, 'erin withdraws after the borrower EOA grants a credential');
  }

  // Limit of the impact: a one-contract wrapper works around the restriction.
  function test_contractWrapper_workaround() external {
    ForwardingPushProvider wrapper = new ForwardingPushProvider(kycOperator);
    vm.prank(borrower);
    hooks.addRoleProvider(address(wrapper), 30 days);
    vm.prank(kycOperator);
    wrapper.grant(hooks, erin);
    (bool ok, ) = _queueWithdrawal(erin);
    assertTrue(ok);
  }

  function _queueWithdrawal(address from) internal returns (bool ok, bytes memory ret) {
    vm.prank(from);
    (ok, ret) = address(market).call(abi.encodeCall(market.queueWithdrawal, (1e18)));
  }
}
