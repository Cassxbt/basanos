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
