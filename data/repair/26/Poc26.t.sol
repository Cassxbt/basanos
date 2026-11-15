// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity ^0.8.25;

import "../helpers/OperatorHelper.sol";

contract Poc26 is OperatorHelper {
    address stranger = address(0xCAFE);
    Operator.QueuedStakeUpdate queuedStake;
    address vault;

    function _operatorRequestsStake() internal {
        deposit_into_vaults();
        vault = address(vaults[0]);
        vm.prank(operator);
        queuedStake = core.requestUpdateVaultStakeInDSS(
            Operator.StakeUpdateRequest({vault: vault, dss: dss, toStake: true})
        );
    }

    function _slashRequest() internal view returns (SlasherLib.SlashRequest memory) {
        address[] memory v = new address[](1);
        v[0] = vault;
        uint96[] memory pct = new uint96[](1);
        pct[0] = uint96(30 * Constants.ONE_WAD);
        return SlasherLib.SlashRequest({operator: operator, slashPercentagesWad: pct, vaults: v});
    }

    // Operator changes its mind on day 1 but has no way to withdraw the request; a stranger finalizes it,
    // the DSS slashes, and nobody vetoes.
    function test_uncancellable_stake_is_finalized_by_stranger_and_slashed() public {
        _operatorRequestsStake();

        // The only operator-side actions on this vault are blocked while the request is pending.
        skip(1 days);
        vm.startPrank(operator);
        core.registerOperatorToDSS(dss2, "");
        vm.expectRevert(PendingStakeUpdateRequest.selector);
        core.requestUpdateVaultStakeInDSS(Operator.StakeUpdateRequest({vault: vault, dss: dss, toStake: false}));
        vm.expectRevert(PendingStakeUpdateRequest.selector);
        core.requestUpdateVaultStakeInDSS(Operator.StakeUpdateRequest({vault: vault, dss: dss2, toStake: true}));
        vm.stopPrank();

        skip(Constants.MIN_STAKE_UPDATE_DELAY);
        vm.prank(stranger);
        core.finalizeUpdateVaultStakeInDSS(queuedStake);
        assertEq(core.fetchVaultsStakedInDSS(operator, dss).length, 1);

        uint256 before = IVault(vault).totalAssets();
        vm.prank(address(dss));
        SlasherLib.QueuedSlashing memory queued = core.requestSlashing(_slashRequest());
        skip(Constants.SLASHING_VETO_WINDOW);
        core.finalizeSlashing(queued);
        uint256 afterSlash = IVault(vault).totalAssets();

        emit log_named_uint("vault totalAssets before slash", before);
        emit log_named_uint("vault totalAssets after slash", afterSlash);
        assertEq(before, 1000);
        assertEq(afterSlash, 700);
    }

    // The operator is not helpless: unregistering during the pending window makes every later slash revert,
    // even after a stranger finalizes the stake.
    function test_operator_can_escape_by_unregistering_during_delay() public {
        _operatorRequestsStake();
        skip(1 days);

        vm.prank(operator);
        core.unregisterOperatorFromDSS(dss, "");

        skip(Constants.MIN_STAKE_UPDATE_DELAY);
        vm.prank(stranger);
        core.finalizeUpdateVaultStakeInDSS(queuedStake);

        vm.prank(address(dss));
        vm.expectRevert(OperatorNotValidatingForDSS.selector);
        core.requestSlashing(_slashRequest());
        assertEq(IVault(vault).totalAssets(), 1000);
    }
}
