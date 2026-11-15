# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/NativeVault.sol#L308


# Vulnerability details

Relevant code: [NativeVault::slashAssets](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/NativeVault.sol#L308)
### Description
`Core`'s state contains a mapping between assets and slashingHandlers - `assetSlashingHandlers`. Assets that are assigned a slashing handler are considered whitelisted and vaults containing this asset can be deployed. 

When a slash is performed on a vault, the following function is called:
```js
function slashAssets(
	uint256 slashPercentageWad, address slashingHandler
) external returns (uint256 transferAmount);
```

Inside `NativeVault`'s implementation of the function, the following check is performed:
```js
if (slashingHandler != self.slashStore) revert NotSlashStore();
```

This check can be problematic in the case where some number of native vaults have been deployed and the `assetSlashingHandlers` mapping gets updated with a new `slashHandler`. Then, the `slashAssets` function will always revert.

### Root Cause
Unsynchronized state update causes DoS of slashing functionality inside `NativeVault`.

### Impact
If the `slashingHandler` for restaking gets changed at some point it will cause DoS of the slashing functionality for `NativeVaults`. It will be blocked until contracts get updated with new implementation or old slashing handler is restored. 

> The issue could be exacerbated if some new `NativeVaults` get deployed with the new slash handler. Then, reverting to the old slash handler will break the newly deployed `NativeVaults`, making update implementation the only option to fix this issue. But this is also troublesome because only normal `Vaults` can have they're implementation updated for all deployments with one call. `NativeVaults` would have to be updated one by one.

### PoC
Lets suppose the following scenario:
1. SlashHandler `A` is set for key `Constants.DEAD_BEEF` in `assetSlashingHandlers`.
2. 5 `NativeVaults` get deployed with this slash handler.
3. SlashHandler `B` is set for `Constants.DEAD_BEEF`.
4. These 5 `NativeVaults` would not be slashable until some measures are taken - either `A` restored or the vault's implementations are updated.

Both approaches to fix this issue once it has occurred have their drawbacks:
- If after **step 3**, more `NativeVaults` are created updating the allowlist will always cause some group of native vaults to be **unslashable**. 
- Changing the `NativeVault` implementations can only be done only 1 by 1, since the default vault implementation is for normal `Vault`.

### Suggested Mitigation
There are multiple ways to prevent this issue:
- Function only callable by `Manager` to change `slashStore`
- Function in `Core` that is callable by anyone which changes the underlying `slashStore` of a `NativeVault` if there is a difference. Allowing users to unDoS themselves.
- Remove the check causing the revert in `slashAssets` and allow `NativeVaults` to have different `slashHandlers` if this is acceptable.


## Assessed type

Other

## Proof of Concept (added after pre-submit check)

```solidity
// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "forge-std/Test.sol";

import "../../src/Core.sol";
import "../../src/NativeNode.sol";
import "../../src/NativeVault.sol";
import "../helpers/ProxyDeployment.sol";
import "../helpers/contracts/MockDSS.sol";

contract Poc49 is Test {
    bytes32 internal constant STATE_SLOT = 0x0e977c4f52771ae90b9a885786536a06e14de7815be95b6ed56cdea86f6fc300;

    Core core;
    NativeVault nativeVault;
    IDSS dss = IDSS(address(new MockDSS()));

    address manager = address(11);
    address operator = address(12);
    address handlerA = address(13);
    address handlerB = address(14);
    address proxyAdmin = address(15);
    address vetoCommittee = address(16);

    function setUp() public {
        core = Core(ProxyDeployment.factoryDeploy(address(new Core()), proxyAdmin));
        core.initialize(address(new NativeVault()), manager, vetoCommittee, 500_000, 20_000, 40_000);

        address[] memory assets = new address[](1);
        assets[0] = Constants.DEAD_BEEF;
        address[] memory handlers = new address[](1);
        handlers[0] = handlerA;
        vm.prank(manager);
        core.allowlistAssets(assets, handlers);

        VaultLib.Config[] memory configs = new VaultLib.Config[](1);
        configs[0] = VaultLib.Config({
            asset: Constants.DEAD_BEEF,
            decimals: 18,
            operator: operator,
            name: "NativeTestVault",
            symbol: "NTV",
            extraData: abi.encode(manager, handlerA, address(new NativeNode()))
        });

        vm.prank(address(dss));
        core.registerDSS(30e18);

        vm.startPrank(operator);
        core.registerOperatorToDSS(dss, "");
        nativeVault = NativeVault(address(core.deployVaults(configs, address(0))[0]));
        Operator.QueuedStakeUpdate memory q = core.requestUpdateVaultStakeInDSS(
            Operator.StakeUpdateRequest({vault: address(nativeVault), dss: dss, toStake: true})
        );
        vm.warp(block.timestamp + Constants.MIN_STAKE_UPDATE_DELAY + 1);
        core.finalizeUpdateVaultStakeInDSS(q);
        vm.stopPrank();

        // Credit the vault with 100 ether of restaked ETH. The beacon-proof path that produces this
        // number is covered by the repo's own nativeVault tests; here only the slashing path matters.
        vm.store(address(nativeVault), bytes32(uint256(STATE_SLOT) + 1), bytes32(uint256(100 ether)));
        assertEq(nativeVault.totalAssets(), 100 ether);
    }

    function _requestSlash() internal returns (SlasherLib.QueuedSlashing memory) {
        uint96[] memory pct = new uint96[](1);
        pct[0] = 10e18;
        address[] memory vs = new address[](1);
        vs[0] = address(nativeVault);
        vm.prank(address(dss));
        return core.requestSlashing(SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: vs}));
    }

    function _setHandler(address handler) internal {
        address[] memory assets = new address[](1);
        assets[0] = Constants.DEAD_BEEF;
        address[] memory handlers = new address[](1);
        handlers[0] = handler;
        vm.prank(manager);
        core.allowlistAssets(assets, handlers);
    }

    function test_handlerChangeBlocksNativeVaultSlashing() public {
        // Control: with the handler unchanged the slash goes through
        SlasherLib.QueuedSlashing memory q1 = _requestSlash();
        skip(Constants.SLASHING_VETO_WINDOW);
        core.finalizeSlashing(q1);
        assertEq(nativeVault.totalAssets(), 90 ether);

        // A new request is queued, then the manager re-points the asset to a new handler
        SlasherLib.QueuedSlashing memory q2 = _requestSlash();
        _setHandler(handlerB);
        skip(Constants.SLASHING_VETO_WINDOW);

        vm.expectRevert(NotSlashStore.selector);
        core.finalizeSlashing(q2);
        assertEq(nativeVault.totalAssets(), 90 ether);

        // Restoring the old handler is the only way (short of per-vault upgrades) to unblock it
        _setHandler(handlerA);
        core.finalizeSlashing(q2);
        assertEq(nativeVault.totalAssets(), 81 ether);
    }
}
```

Run: forge test --match-path test/basanos/Poc49.t.sol -vv

```
Ran 1 test for test/basanos/Poc49.t.sol:Poc49
[PASS] test_handlerChangeBlocksNativeVaultSlashing() (gas: 430073)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 2.69ms (782.04µs CPU time)
Ran 1 test suite in 140.24ms (2.69ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

## Response to reviewer checklist

1. NativeVaults are deployed with asset `Constants.DEAD_BEEF` (enforced by `NativeVault.initialize`), and `deployVaults` requires `assetSlashingHandlers[DEAD_BEEF] != 0`, which is set via `allowlistAssets`. The PoC deploys the vault exactly that way, with `slashStore` equal to the allowlisted handler A in `extraData`.
2. Re-pointing an already allowlisted asset is a supported call (the `allowlistAssets` natspec says passing an already allowlisted asset sets it again, and the mapping is overwritten with no check against existing vaults), but it is a MANAGER/owner-only action. I cannot remove that precondition: the harm requires a trusted role acting through a normal admin function, so this should be judged as a Low/QA-level robustness issue (admin action silently bricks NativeVault slashing), not a permissionless attack. The checker's out-of-scope concern stands.
3. End-to-end demonstration added: a queued slash finalizes normally with the handler unchanged (100 -> 90 ether), then after the manager sets handler B a queued slash reverts with `NotSlashStore` in `finalizeSlashing`, and restoring handler A lets the same request finalize (90 -> 81 ether). Caveat: the vault's `totalAssets` is credited with `vm.store` instead of a full beacon-proof flow; the slashing path under test does not depend on how the balance was produced.
