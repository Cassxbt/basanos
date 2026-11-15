// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "../helpers/OperatorHelper.sol";

contract Poc4 is OperatorHelper {
    address bob = address(0xB0B);

    function test_slash_finalizes_after_operator_unregistered() public {
        stake_vaults_to_dss();
        address[] memory operatorVaults = core.fetchVaultsStakedInDSS(operator, dss);
        assertEq(operatorVaults.length, 2);

        vm.startPrank(operator);
        Operator.QueuedStakeUpdate memory q0 = core.requestUpdateVaultStakeInDSS(
            Operator.StakeUpdateRequest({vault: operatorVaults[0], dss: dss, toStake: false})
        );
        Operator.QueuedStakeUpdate memory q1 = core.requestUpdateVaultStakeInDSS(
            Operator.StakeUpdateRequest({vault: operatorVaults[1], dss: dss, toStake: false})
        );
        vm.stopPrank();

        skip(8 days);

        uint96[] memory pct = new uint96[](2);
        pct[0] = uint96(10 * Constants.ONE_WAD);
        pct[1] = uint96(10 * Constants.ONE_WAD);
        vm.prank(address(dss));
        SlasherLib.QueuedSlashing memory queued = core.requestSlashing(
            SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: operatorVaults})
        );

        skip(1 days);
        vm.startPrank(operator);
        core.finalizeUpdateVaultStakeInDSS(q0);
        core.finalizeUpdateVaultStakeInDSS(q1);
        core.unregisterOperatorFromDSS(dss, "");
        vm.stopPrank();

        assertFalse(core.isOperatorRegisteredToDSS(operator, dss));
        assertEq(core.fetchVaultsStakedInDSS(operator, dss).length, 0);

        // The operator is now unregistered and the vault is staked to no DSS, so the DSS can no longer
        // issue a new slash: this proves finalization below is the only path left.
        vm.prank(address(dss));
        vm.expectRevert(OperatorNotValidatingForDSS.selector);
        core.requestSlashing(
            SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: operatorVaults})
        );

        // A new staker deposits into vault 0, which no DSS can slash according to Core's state
        depositToken.mint(bob, 1000);
        vm.startPrank(bob);
        depositToken.approve(operatorVaults[0], 1000);
        uint256 bobShares = IVault(operatorVaults[0]).deposit(1000, bob, 0);
        vm.stopPrank();
        uint256 bobBefore = Vault(operatorVaults[0]).convertToAssets(bobShares);
        assertEq(bobBefore, 1000);

        uint256 v0Before = IVault(operatorVaults[0]).totalAssets();
        uint256 v1Before = IVault(operatorVaults[1]).totalAssets();
        uint256 burnedBefore = depositToken.balanceOf(address(0));

        skip(1 days);
        core.finalizeSlashing(queued);

        uint256 v0After = IVault(operatorVaults[0]).totalAssets();
        uint256 v1After = IVault(operatorVaults[1]).totalAssets();
        uint256 bobAfter = Vault(operatorVaults[0]).convertToAssets(bobShares);

        emit log_named_uint("vault0 totalAssets before", v0Before);
        emit log_named_uint("vault0 totalAssets after", v0After);
        emit log_named_uint("vault1 totalAssets before", v1Before);
        emit log_named_uint("vault1 totalAssets after", v1After);
        emit log_named_uint("bob redeemable before", bobBefore);
        emit log_named_uint("bob redeemable after", bobAfter);
        emit log_named_uint("tokens burned (sent to address(0))", depositToken.balanceOf(address(0)) - burnedBefore);

        assertFalse(core.isOperatorRegisteredToDSS(operator, dss));
        assertEq(v0Before - v0After, 100);
        assertEq(v1Before - v1After, 100);
        assertEq(depositToken.balanceOf(address(0)) - burnedBefore, 200);
        assertEq(bobAfter, 950);
    }
}
