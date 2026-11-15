// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "../helpers/OperatorHelper.sol";

contract Poc7 is OperatorHelper {
    function test_zeroAssetVaultBlocksFinalize() public {
        stake_vaults_to_dss();
        IVault vault1 = IVault(address(vaults[0]));
        IVault vault2 = IVault(address(vaults[1]));
        assertEq(vault1.totalAssets(), 1000);
        assertEq(vault2.totalAssets(), 1000);

        // Normal full withdrawal through the intended startRedeem/finishRedeem flow
        IERC20(address(vault1)).approve(address(vault1), 1000);
        bytes32 withdrawalKey = vault1.startRedeem(1000, address(this));
        skip(Constants.MIN_WITHDRAWAL_DELAY);

        // DSS requests a 10% slash on both vaults; vault1 still holds 1000 so earmark = 100
        uint96[] memory slashPercentagesWad = new uint96[](2);
        slashPercentagesWad[0] = uint96(10e18);
        slashPercentagesWad[1] = uint96(10e18);
        address[] memory operatorVaults = core.fetchVaultsStakedInDSS(operator, dss);
        SlasherLib.SlashRequest memory req = SlasherLib.SlashRequest({
            operator: operator,
            slashPercentagesWad: slashPercentagesWad,
            vaults: operatorVaults
        });
        vm.prank(address(dss));
        SlasherLib.QueuedSlashing memory queued = core.requestSlashing(req);
        assertEq(queued.earmarkedStakes[0], 100);
        assertEq(queued.earmarkedStakes[1], 100);

        // Staker completes the (already mature) withdrawal during the veto window
        skip(1 days);
        vault1.finishRedeem(withdrawalKey);
        assertEq(vault1.totalAssets(), 0);

        // The empty vault is STILL staked to the DSS: it remains in the slashing set
        assertTrue(_contains(core.fetchVaultsStakedInDSS(operator, dss), address(vault1)));
        assertEq(core.fetchVaultsStakedInDSS(operator, dss).length, 2);

        // After the veto window, finalize reverts and the healthy vault is not slashed
        skip(1 days);
        vm.expectRevert(ZeroAmount.selector);
        core.finalizeSlashing(queued);
        assertEq(vault2.totalAssets(), 1000);
        assertEq(depositToken.balanceOf(address(vault2)), 1000);

        // Anyone can retry but the revert is deterministic while vault1 is empty and the request stays queued
        vm.expectRevert(ZeroAmount.selector);
        core.finalizeSlashing(queued);
    }

    function _contains(address[] memory a, address x) internal pure returns (bool) {
        for (uint256 i; i < a.length; i++) if (a[i] == x) return true;
        return false;
    }
}
