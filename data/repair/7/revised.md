# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L220
https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L193
https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/SlashingHandler.sol#L52


# Vulnerability details

## **Vulnerability Details:**

The [requestSlashing](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Core.sol#L220) function allows a slashing to be requested for a given operator’s deployed vaults staked to the DSS.  The slashing request must pass the SLASHING_VETO_WINDOW (2 days) before it can be confirmed, allowing the veto committee to cancel any unfair queued slashing.

This time gap can create situations where the requested slashed amount is no longer possible, as the contract might have had previous withdrawals or been slashed by other DSS’s in that time, reducing its overall balance. The [slashAssets](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L193) function in the vault contract handles this by taking the minimum of the requested slashed amount and the contract balance.

```solidity
    function slashAssets(uint256 totalAssetsToSlash, address slashingHandler)
        external
        onlyCore
        returns (uint256 transferAmount)
    {
        transferAmount = Math.min(totalAssets(), totalAssetsToSlash);

        // Approve to the handler and then call the handler which will draw the funds
        SafeTransferLib.safeApproveWithRetry(asset(), slashingHandler, transferAmount);
        ISlashingHandler(slashingHandler).handleSlashing(IERC20(asset()), transferAmount);

        emit Slashed(transferAmount);
    }
```

However, if the total assets in the contract are zero, the transferAmount will be zero. When this zero value is passed to the [handleSlashing](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/SlashingHandler.sol#L52) function, it will revert due to a check that ensures the amount is not zero.

- Since DSS can slash 100% of a vault and vaults can be staked to multiple DSS, it is possible that a vault could be slashed before this slashing request, leaving its total assets as zero.
- Another scenario is if there were pending withdrawals that were completed before the slashing, resulting in the total assets being zero after the withdrawals.

```solidity

    function handleSlashing(IERC20 token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!_config().supportedAssets[token]) revert UnsupportedAsset();

        SafeTransferLib.safeTransferFrom(address(token), msg.sender, address(this), amount);
        // Below is where custom logic for each asset lives
        SafeTransferLib.safeTransfer(address(token), address(0), amount);
    }
```

As a result, if this slashing reverts and since a slash request can include multiple slashes for different vaults, the entire transaction will revert, blocking other vault slashes as well.

- Consider the following scenario:
    - A DSS requests  a slash for all 32 vaults of one of its registered operators.
    - One of these vaults has its total assets reduced to zero, either due to another DSS slash or because pending withdrawals were completed.
    - After the two-day veto period, the finalizeSlashing function is called but fails because the slash function of the vault with zero assets reverts.
        - As a result, the other 31 vaults cannot be slashed either.
- Additional Complications:
    - The operator must create another slash request excluding the problematic vault and go through the process again, including another two-day veto period.
        - This could affect the slash amount if other users complete withdrawals during this time.
    - The pending request must also be canceled by the veto; otherwise, if the zero-asset vault becomes non-zero, it could lead to an incorrect double slashing as anyone can finalize a slash request.

## **Impact:**

If the slashAssets function encounters this scenario while attempting to slash assets, it will cause the entire transaction to revert. This will block other slashing requests within the same transaction and lead to additional logical issues as described above.

## **Proof Of Concept:**

```solidity
    function test_slash_fails() public {
        // register operator to dss, deploy vaults, stake vaults to dss
        stake_vaults_to_dss();
        // check if operator is registered to dss
        assertEq(true, core.isOperatorRegisteredToDSS(operator, dss));
        // request full withdraw from vault 1
        vault1.approve(address(vault1), 1000);
        IVault(address(vault1)).startRedeem(1000, address(this));
        skip(8 days);
        // dss request slashing
        address[] memory operatorVaults = core.fetchVaultsStakedInDSS(operator, dss);
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
        // finalize withdraw from vault 1
        bytes32 expectedWithdrawalKey = keccak256(abi.encode(address(this), 0));
        IVault(address(vault1)).finishRedeem(expectedWithdrawalKey);
        // check vault 1 total assets
        assertEq(vault1.totalAssets(), 0);
        skip(1 days);
        // finalize slashing reverts blocking all slashing
        vm.expectRevert(ZeroAmount.selector);
        core.finalizeSlashing(queuedSlashing);
    }
```

## **Tools Used:**

- Manual analysis
- Foundry

## **Recommendation:**

The slashAssets function in the vault contract should only approve and call handleSlashing if transferAmount is greater than zero. This way, the function will not revert, and other slashes will go through.

```

    function slashAssets(uint256 totalAssetsToSlash, address slashingHandler)
        external
        onlyCore
        returns (uint256 transferAmount)
    {
        transferAmount = Math.min(totalAssets(), totalAssetsToSlash);
        if (transferAmount > 0) { // Add here
            // Approve to the handler and then call the handler which will draw the funds
            SafeTransferLib.safeApproveWithRetry(asset(), slashingHandler, transferAmount);
            ISlashingHandler(slashingHandler).handleSlashing(IERC20(asset()), transferAmount);
        }
        emit Slashed(transferAmount);
    }
```


## Assessed type

Invalid Validation

## Proof of Concept (added after pre-submit check)

```solidity
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
```

Run: forge test --match-path test/basanos/Poc7.t.sol -vv

```
Ran 1 test for test/basanos/Poc7.t.sol:Poc7
[PASS] test_zeroAssetVaultBlocksFinalize() (gas: 1793424)
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 3.17ms (1.51ms CPU time)
Ran 1 test suite in 138.83ms (3.17ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

## Response to reviewer checklist

1. Vault remains staked after reaching zero assets: the test asserts `fetchVaultsStakedInDSS(operator, dss)` still returns both vaults, with vault1 included and `vault1.totalAssets() == 0`, after `finishRedeem`. `finishRedeem` never touches operator/DSS stake state; removing a vault from the DSS needs a separate `requestUpdateVaultStakeInDSS` plus the 9-day `MIN_STAKE_UPDATE_DELAY`.
2. startRedeem/finishRedeem is the intended withdrawal flow and the withdrawal itself is not claimed to be a bug. The defect is that `Vault.slashAssets` forwards `transferAmount == 0` to `handleSlashing`, which reverts with `ZeroAmount`, so a completely benign withdrawal (or a prior 100% slash by another DSS) turns the whole `finalizeSlashing` into a revert. The test uses the real timing: redeem started, `MIN_WITHDRAWAL_DELAY` (9 days) elapses, the DSS requests the slash (earmark 100 on each vault), the staker finishes the matured redeem inside the veto window, and finalize then reverts.
