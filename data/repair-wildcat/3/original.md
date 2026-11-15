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