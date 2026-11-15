# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/main/src/Core.sol#L146


# Vulnerability details

## Impact
If an operator no longer wants to stake a vault after submitting a vault staking request, it is not able to cancel that request. Considering the scenario of a malicios/compromised DSS, an operator staking a vault will not be able to cancel their staking request. Furthermore, by design anyone can finalize a staking request. This would put operators at risk of unfair slashing of their funds. This risk is somewhat mitigated by the veto committee which can cancel slashing requests. At the very least the vault funds will be unsuable for the unstaking + staking to new DSS duration of 18 days.

## Proof of Concept
There is no function to cancel a staking request and the `finalizeUpdateVaultStakeInDSS()` function is callable by anyone:

```js
    /// @notice Allows anyone to finish the queued request for an operator to update assets delegated to a DSS
    /// @dev Only operator can finish their queued request valid only after a
    /// minimum delay of `Constants.MIN_STAKE_UPDATE_DELAY` after starting the request
    function finalizeUpdateVaultStakeInDSS(Operator.QueuedStakeUpdate memory queuedStake)
        external
        nonReentrant
        whenFunctionNotPaused(Constants.PAUSE_CORE_FINALIZE_STAKE_UPDATE)
    {
        _self().validateAndUpdateVaultStakeInDSS(queuedStake);
        emit FinishedStakeUpdate(queuedStake);
    }
```

This means a malicios DSS can finalize vault staking requests even when this is not desireable by the operator.

Consider the following scenario:

An operator wants to stake its vault to a DSS, so it submits a vault staking request via `requestUpdateVaultStakeInDSS()`. This would set a timer of `MIN_STAKE_UPDATE_DELAY = 9 days` after which the request can be finalized.

During this time of 9 days, the DSS turns out to be malicios and is unfairly slashing user funds.

The operator cannot remove his request and the malicios DSS finilizes the request by calling `finalizeUpdateVaultStakeInDSS()` and then slashes the user funds.

The veto commitee does not react on time and the operator loses his funds. Note that even if the veto committee reacts on time, the user funds will be unusable for the duration of unstaking the vault(9) and staking it to a new DSS(another 9 days), since there can be only one stake/unstake request per vault at a time.

## Tools Used
Manual Review

## Recommended Mitigation Steps
Allow operators to cancel vault staking requests


## Assessed type

Other

## Proof of Concept (added after pre-submit check)

```solidity
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
```

Run: forge test --match-path test/basanos/Poc26.t.sol -vv

```
Ran 2 tests for test/basanos/Poc26.t.sol:Poc26
[PASS] test_operator_can_escape_by_unregistering_during_delay() (gas: 1401843)
[PASS] test_uncancellable_stake_is_finalized_by_stranger_and_slashed() (gas: 1745167)
Logs:
  vault totalAssets before slash: 1000
  vault totalAssets after slash: 700

Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 11.56ms (7.48ms CPU time)

Ran 1 test suite in 217.75ms (11.56ms CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)
```

## Response to reviewer checklist

1. Registered malicious DSS finalizes the queued stake and slashes: done. `test_uncancellable_stake_is_finalized_by_stranger_and_slashed` registers the operator with the DSS, queues a stake, shows the operator cannot start any other update on the vault while the request is pending (`PendingStakeUpdateRequest`), has an unrelated address finalize it, and the DSS slash takes the vault from 1000 to 700 once the veto window passes without a veto.
2. Third party finalizes and slashing follows: both shown in the same test (finalizer is address 0xCAFE).
3. Quantify loss and compare with design: the loss in the test is 30% of the vault, the DSS maximum, and requires the veto committee to stay silent. I also found a mitigation the original finding overlooked. `test_operator_can_escape_by_unregistering_during_delay` shows the operator can call `unregisterOperatorFromDSS` while the stake is pending, because the staked-vault set is still empty. After a stranger finalizes, `requestSlashing` reverts with `OperatorNotValidatingForDSS` and the vault keeps 1000. The "cannot cancel" claim is therefore true, but the claimed inevitability of loss is not: an attentive operator can avoid it, so the real impact is narrower (an operator that misses the 9-day window, plus a vault blocked from other stake updates during it).
