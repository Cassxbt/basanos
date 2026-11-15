// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.20;

import '../BaseMarketTest.sol';

contract Poc3 is BaseMarketTest {
  using LibHooksConfig for HooksConfig;

  address internal constant StaleAddress = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;

  // The clear step `shr(96, shl(96, hooks))` keeps config bits 0..159, i.e. the flag bits plus
  // bits 96..159 which belong to the address field (the low 64 bits of the old address).
  function test_poc3_clearStepRetainsLow64BitsOfOldAddress() external {
    address oldAddress = StaleAddress;
    address newAddress = address(0x1111111111111111111111111111111111111111);
    HooksConfig oldConfig = EmptyHooksConfig.setHooksAddress(oldAddress);

    uint256 afterClear;
    assembly {
      afterClear := shr(96, shl(96, oldConfig))
    }
    assertGt(afterClear >> 96, 0, 'address bits survive the clear step');

    HooksConfig updated = oldConfig.setHooksAddress(newAddress);
    address result = updated.hooksAddress();
    assertTrue(result != newAddress, 'address is not the one that was set');
    assertEq(
      result,
      address(uint160(uint160(newAddress) | (uint160(oldAddress) & type(uint64).max))),
      'new address OR low 64 bits of old address'
    );
  }

  function test_poc3_logValues() external {
    address oldAddress = StaleAddress;
    address newAddress = address(0x1111111111111111111111111111111111111111);
    HooksConfig oldConfig = EmptyHooksConfig.setHooksAddress(oldAddress);
    uint256 afterClear;
    assembly {
      afterClear := shr(96, shl(96, oldConfig))
    }
    emit log_named_bytes32('config word after clear step', bytes32(afterClear));
    emit log_named_address('old address', oldAddress);
    emit log_named_address('requested new address', newAddress);
    emit log_named_address('address read back', oldConfig.setHooksAddress(newAddress).hooksAddress());
  }

  // Reachable through the HooksFactory: deployMarketAndHooks calls
  // `parameters.hooks.setHooksAddress(hooksInstance)` on a borrower-supplied config.
  function _deployMarketAndHooks(HooksConfig inputConfig, bytes32 salt) internal returns (address, address) {
    DeployMarketInputs memory inputs = DeployMarketInputs({
      asset: address(asset),
      namePrefix: 'Wildcat ',
      symbolPrefix: 'WC',
      maxTotalSupply: uint128(DefaultMaximumSupply),
      annualInterestBips: 1000,
      delinquencyFeeBips: DefaultDelinquencyFee,
      withdrawalBatchDuration: DefaultWithdrawalBatchDuration,
      reserveRatioBips: DefaultReserveRatio,
      delinquencyGracePeriod: DefaultGracePeriod,
      hooks: inputConfig
    });
    vm.prank(borrower);
    return hooksFactory.deployMarketAndHooks(hooksTemplate, '', inputs, '', salt, address(0), 0);
  }

  function test_poc3_factoryControlCleanInputWorks() external {
    (address market_, address instance) = _deployMarketAndHooks(
      EmptyHooksConfig,
      bytes32(uint256(uint160(borrower)) << 96 | 0x100)
    );
    assertEq(WildcatMarket(market_).hooks().hooksAddress(), instance, 'market uses the new hooks instance');
  }

  function test_poc3_factoryDirtyAddressBitsBreakDeployment() external {
    // Same call, but the input config carries a stale address in its address field.
    HooksConfig dirty = EmptyHooksConfig.setHooksAddress(
      StaleAddress
    );
    address expectedInstance = computeCreateAddress(
      address(hooksFactory),
      vm.getNonce(address(hooksFactory))
    );
    address corrupted = address(
      uint160(uint160(expectedInstance) | (uint160(StaleAddress) & type(uint64).max))
    );
    emit log_named_address('hooks instance that will be deployed', expectedInstance);
    emit log_named_address('address the factory will treat as hooks', corrupted);
    assertTrue(corrupted != expectedInstance);
    assertEq(corrupted.code.length, 0);

    vm.expectRevert();
    _deployMarketAndHooks(dirty, bytes32(uint256(uint160(borrower)) << 96 | 0x101));
  }
}
