# The `setHooksAddress` implementation is incorrect.

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/types/HooksConfig.sol#L90


# Vulnerability details

## Proof of Concept
The `setHooksAddress` function is used to set the `hooksAddress` in the `HooksConfig`. However, due to a shift error in the function, the original `hooksAddress` cannot be properly cleared. If the `hooksAddress` is set a second time, it will be incorrectly configured.  

github:[https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/types/HooksConfig.sol#L84](https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/types/HooksConfig.sol#L84)
```
  function setHooksAddress(
    HooksConfig hooks,
    address _hooksAddress
  ) internal pure returns (HooksConfig updatedHooks) {
    assembly {
      // Shift twice to clear the address
      updatedHooks := shr(96, shl(96, hooks))
      // Set the new address
      updatedHooks := or(updatedHooks, shl(96, _hooksAddress))
    }
  }
```
In `HooksConfig`, the upper 160 bits store the `hooksAddress`. However, when attempting to clear the original `hooksAddress`, the function only shifts `HooksConfig` 96 bits to the left. This causes the `hooksAddress` to not be fully cleared, resulting in errors when setting a new `hooksAddress`.

## Recommended Mitigation Steps
Shifting the `hooksAddress` by 160 bits to the left will completely clear the original `hooksAddress`.  
```diff
  function setHooksAddress(
    HooksConfig hooks,
    address _hooksAddress
  ) internal pure returns (HooksConfig updatedHooks) {
    assembly {
      // Shift twice to clear the address
-     updatedHooks := shr(96, shl(96, hooks))
+     updatedHooks := shr(160, shl(160, hooks))
      // Set the new address
      updatedHooks := or(updatedHooks, shl(96, _hooksAddress))
    }
  }
```


## Assessed type

Error

## Proof of concept (executed against the audited commit)

The tests below run against the unmodified audited code. `test_poc3_clearStepRetainsLow64BitsOfOldAddress` computes the clear step on a config whose address is 0xaAaA...aAaA and shows the word after `shr(96, shl(96, x))` still has non-zero bits at and above bit 96 (`0x...aaaaaaaaaaaaaaaa000000000000000000000000`, i.e. the low 64 bits of the old address); setting `0x1111...1111` on it reads back as `0x111111111111111111111111BbBbBBbBBBbBBBBb` (new address OR the low 64 bits of the old one). The two factory tests exercise the only in-protocol call site, `HooksFactory.deployMarketAndHooks` (`parameters.hooks.setHooksAddress(hooksInstance)`): with a clean input config the market gets the new hooks instance, while with an input config carrying a stale address the factory treats a different address (an address with no code) as the hooks instance and the deployment reverts. The test does not show any impact beyond this: the input config is supplied by the borrower making the call, and only the low 64 bits of the address are retained, so the top 96 address bits always come from the new instance.

```solidity
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
```

Real `forge test --match-path test/repair/Poc3.t.sol -vv` output:

```
Warning: Found unknown `fuzz_runs` config for profile `coverage` defined in foundry.toml.
Compiling 1 files with Solc 0.8.25
Solc 0.8.25 finished in 1.47s
Compiler run successful!
error: unresolved symbol `locals`
   --> src/spherex/SphereXProtectedRegisteredBase.sol:153:39
    |
153 |   ) internal returnsIfNotActivatedPre(locals) returns (ModifierLocals memory locals) {
    |                                       ^^^^^^


Ran 4 tests for test/repair/Poc3.t.sol:Poc3
[PASS] test_poc3_clearStepRetainsLow64BitsOfOldAddress() (gas: 6160)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_poc3_factoryControlCleanInputWorks() (gas: 11891018)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.

[PASS] test_poc3_factoryDirtyAddressBitsBreakDeployment() (gas: 4578495)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  hooks instance that will be deployed: 0x564D000Ba40e907478790B54319506460389127a
  address the factory will treat as hooks: 0x564D000Ba40E907478790b54bBbFAEeEAbAbbaFA

[PASS] test_poc3_logValues() (gas: 9251)
Logs:
  computeCreateAddress is deprecated. Please use vm.computeCreateAddress instead.
  config word after clear step: 0x000000000000000000000000aaaaaaaaaaaaaaaa000000000000000000000000
  old address: 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa
  requested new address: 0x1111111111111111111111111111111111111111
  address read back: 0x111111111111111111111111BbBbBBbBBBbBBBBb

Suite result: ok. 4 passed; 0 failed; 0 skipped; finished in 4.62ms (1.48ms CPU time)

Ran 1 test suite in 139.79ms (4.62ms CPU time): 4 tests passed, 0 failed, 0 skipped (4 total tests)
```

## Response to the pre-screen checklist

1. A concrete input where the clear step leaves bits >= 96 non-zero: the pre-screen's premise that "the code shows it cannot" is incorrect. The address occupies config bits 96..255, and `shl(96, x)` only discards bits 160..255, so bits 96..159 survive the subsequent `shr(96, ...)`. Concrete input: a config with address `0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa` gives, after the clear step, `0x000000000000000000000000aaaaaaaaaaaaaaaa000000000000000000000000` (shown in `test_poc3_logValues` and asserted in `test_poc3_clearStepRetainsLow64BitsOfOldAddress`).
