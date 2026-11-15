# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L130
https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L220
https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L248


# Vulnerability details

## **Vulnerability Details:**

Operators select DSSs to allocate their funds to, and for each DSS, they can choose a list of vaults to stake. The selected vaults are fully staked to the chosen DSS. 

To unstake, the operator must adhere to a MIN_STAKE_UPDATE_DELAY of 9 days, which prevents front-running a slashing event. An operator can fully unregister from a DSS once all the vaults are unstaked. The DSS has the ability to slash any malicious behaviour that occurred before the withdrawal initiation for up to 7 days.

The problem is, the current implementation breaks one of the main invariants (confirmed by sponsors).

- [**Only DSSs an operator is registered with can slash said operator**](https://code4rena.com/audits/2024-07-karak-restaking#top:~:text=Only%20DSSs%20an%20operator%20is%20registered%20with%20can%20slash%20said%20operator)

Consider the following scenario:

- Operator calls the [requestUpdateVaultStakeInDSS](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L130) function to unstake Vault 1 from DSS, initiating the 9-day `MIN_STAKE_UPDATE_DELAY`.
- After 8 days, the DSS calls the [requestSlashing](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L220) function on Operator’s Vault 1, starting the 2-day `SLASHING_VETO_WINDOW`.
- After 1 day, the operator calls the [finalizeUnstaking](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L248C14-L248C30) function to finalize unstaking Vault 1 from DSS and the [unregisterOperatorFromDSS](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L113C14-L113C39) function to unregister from DSS.
- After another day, the DSS (or anyone) calls the [finalizeSlashing](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L248C14-L248C30) function to finalize the slash on the operator, who is no longer registered with the DSS.

## **Proof Of Concept:**

```solidity
    function test_slash_unregistered_operator() public {
        // register operator to dss, deploy vaults, stake vaults to dss
        stake_vaults_to_dss();
        // check if operator is registered to dss
        assertEq(true, core.isOperatorRegisteredToDSS(operator, dss));
        // unstake vaults from dss
        address[] memory operatorVaults = core.fetchVaultsStakedInDSS(operator, dss);
        Operator.StakeUpdateRequest memory stakeUpdate =
            Operator.StakeUpdateRequest({vault: operatorVaults[0], dss: dss, toStake: false});
        Operator.StakeUpdateRequest memory stakeUpdate2 =
            Operator.StakeUpdateRequest({vault: operatorVaults[1], dss: dss, toStake: false});
        vm.startPrank(operator);
        Operator.QueuedStakeUpdate memory queuedStakeUpdate = core.requestUpdateVaultStakeInDSS(stakeUpdate);
        Operator.QueuedStakeUpdate memory queuedStakeUpdate2 = core.requestUpdateVaultStakeInDSS(stakeUpdate2);
        vm.stopPrank();
        skip(8 days);
        // dss request slashing
        uint96[] memory slashPercentagesWad = new uint96[](2);
        slashPercentagesWad[0] = uint96(10e18);
        slashPercentagesWad[1] = uint96(10e18);
        SlasherLib.SlashRequest memory slashingReq = SlasherLib.SlashRequest({
            operator: operator,
            slashPercentagesWad: slashPercentagesWad,
            vaults: operatorVaults
        });
        vm.startPrank(address(dss));
        SlasherLib.QueuedSlashing memory queuedSlashing = core.requestSlashing(slashingReq);
        vm.stopPrank();
        skip(1 days);
        vm.startPrank(operator);
        // finalize unstake and unregister operator from dss
        core.finalizeUpdateVaultStakeInDSS(queuedStakeUpdate);
        core.finalizeUpdateVaultStakeInDSS(queuedStakeUpdate2);
        core.unregisterOperatorFromDSS(dss, "");
        vm.stopPrank();
        skip(1 days);
        // check if operator is unregistered from dss
        assertEq(false, core.isOperatorRegisteredToDSS(operator, dss));
        // finalize slashing on unregistered operator
        core.finalizeSlashing(queuedSlashing);
    }
```

## **Impact:**

The current implementation allows a DSS to finalize a slash on an operator even after the operator has unregistered from the DSS. This breaks the intended invariant that only DSSs an operator is registered with can slash that operator. 

Additionally, new users depositing into the DSS may be unaware of the pending slash because the operator is no longer registered with the DSS, leading to a potential loss on deposits. 

## **Tools Used:**

- Manual analysis
- Foundry

## **Recommendation:**

Consider implementing a check to prevent operators from unregistering from a DSS that has pending slashing requests on them. This will ensure that all slashing actions are finalized before an operator can fully unregister, thereby maintaining the intended invariant/design.





## Assessed type

Other

## Proof of Concept (added after pre-submit check)

```solidity
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
```

Run: forge test --match-path test/basanos/Poc4.t.sol -vv

```
Ran 1 test for test/basanos/Poc4.t.sol:Poc4
[PASS] test_slash_finalizes_after_operator_unregistered() (gas: 1869996)
Logs:
  vault0 totalAssets before: 2000
  vault0 totalAssets after: 1900
  vault1 totalAssets before: 1000
  vault1 totalAssets after: 900
  bob redeemable before: 1000
  bob redeemable after: 950
  tokens burned (sent to address(0)): 200

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 3.31ms (1.72ms CPU time)

Ran 1 test suite in 137.81ms (3.31ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

## Response to reviewer checklist

1. Confirm the invariant applies at finalization: I cannot establish this from the code or README alone. The README states the invariant ("Only DSSs an operator is registered with can slash said operator") and separately says a DSS can slash conduct before unstake initiation for up to 7 days, so a judge may read a request made while registered as sufficient. The PoC shows what the code actually does: `requestSlashing` re-checks registration (it reverts with `OperatorNotValidatingForDSS` once the operator has unregistered, asserted in the test) but `finalizeSlashing` does not, so a slash queued while registered executes after unregistration. I flag this as a design-intent question, not a settled bug.
2. Demonstrate an actual balance reduction: done. After the operator is unregistered and both vaults are staked to no DSS, `finalizeSlashing` reduces vault 0 and vault 1 `totalAssets` by 100 each, 200 tokens are burned (sent to address(0)), and a staker who deposited after unregistration (when Core's state shows no DSS able to slash the vault) sees 1000 become 950.
