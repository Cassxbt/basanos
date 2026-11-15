# The new withdrawal batch may be prioritized over the expired withdrawal batch for repayment

# Lines of code

https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/market/WildcatMarketWithdrawals.sol#L153


# Vulnerability details

## Proof of Concept

The README file states:
*Withdrawal request amounts that could not be honoured in a given cycle because of insufficient reserves are batched together, marked as 'expired' and enter a FIFO withdrawal queue. Non-zero withdrawal queues impact the reserve ratio of a market: any assets subsequently deposited by the borrower will be immediately routed into the claimable withdrawals pool until there are sufficient assets to fully honour all expired withdrawals.*  

However, in reality, both the assets sent by the `borrower` through the `repay` function and those directly `transfer` to the `market` contract are used to pay for the new withdrawal batches or remain in the contract, rather than repaying the expired batches. This can result in the new withdrawal batches being prioritized for repayment over the expired ones.
github:[https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/market/WildcatMarket.sol#L202](https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/market/WildcatMarket.sol#L202)
```solidity
  function repay(uint256 amount) external nonReentrant sphereXGuardExternal {
    if (amount == 0) revert_NullRepayAmount();

    asset.safeTransferFrom(msg.sender, address(this), amount);
    emit_DebtRepaid(msg.sender, amount);

    MarketState memory state = _getUpdatedState();
    if (state.isClosed) revert_RepayToClosedMarket();

    // Execute repay hook if enabled
    hooks.onRepay(amount, state, _runtimeConstant(0x24));

    _writeState(state);
  }
```
github:[https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/market/WildcatMarketBase.sol#L406](https://github.com/code-423n4/2024-08-wildcat/blob/fe746cc0fbedc4447a981a50e6ba4c95f98b9fe1/src/market/WildcatMarketBase.sol#L406)
```solidity
  function _getUpdatedState() internal returns (MarketState memory state) {
    state = _state;
    // Handle expired withdrawal batch
    if (state.hasPendingExpiredBatch()) {
      uint256 expiry = state.pendingWithdrawalExpiry;
      // Only accrue interest if time has passed since last update.
      // This will only be false if withdrawalBatchDuration is 0.
      uint32 lastInterestAccruedTimestamp = state.lastInterestAccruedTimestamp;
      if (expiry != lastInterestAccruedTimestamp) {
        (uint256 baseInterestRay, uint256 delinquencyFeeRay, uint256 protocolFee) = state
          .updateScaleFactorAndFees(
            delinquencyFeeBips,
            delinquencyGracePeriod,
            expiry
          );
        emit_InterestAndFeesAccrued(
          lastInterestAccruedTimestamp,
          expiry,
          state.scaleFactor,
          baseInterestRay,
          delinquencyFeeRay,
          protocolFee
        );
      }
      _processExpiredWithdrawalBatch(state);
    }
    uint32 lastInterestAccruedTimestamp = state.lastInterestAccruedTimestamp;
    // Apply interest and fees accrued since last update (expiry or previous tx)
    if (block.timestamp != lastInterestAccruedTimestamp) {
      (uint256 baseInterestRay, uint256 delinquencyFeeRay, uint256 protocolFee) = state
        .updateScaleFactorAndFees(
          delinquencyFeeBips,
          delinquencyGracePeriod,
          block.timestamp
        );
      emit_InterestAndFeesAccrued(
        lastInterestAccruedTimestamp,
        block.timestamp,
        state.scaleFactor,
        baseInterestRay,
        delinquencyFeeRay,
        protocolFee
      );
    }

    // If there is a pending withdrawal batch which is not fully paid off, set aside
    // up to the available liquidity for that batch.
    if (state.pendingWithdrawalExpiry != 0) {
      uint32 expiry = state.pendingWithdrawalExpiry;
      WithdrawalBatch memory batch = _withdrawalData.batches[expiry];
      if (batch.scaledAmountBurned < batch.scaledTotalAmount) {
        // Burn as much of the withdrawal batch as possible with available liquidity.
        uint256 availableLiquidity = batch.availableLiquidityForPendingBatch(state, totalAssets());
        if (availableLiquidity > 0) {
          _applyWithdrawalBatchPayment(batch, state, expiry, availableLiquidity);
          _withdrawalData.batches[expiry] = batch;
        }
      }
    }
  }
```

It can be observed that when the `_getUpdatedState()` function updates the state, it uses the available funds in the current contract to prioritize the repayment of the current batch of withdrawal requests. If there are no new withdrawal requests in the current batch, the funds will remain in the contract instead of repaying the expired batches.
In reality, only by calling the `repayAndProcessUnpaidWithdrawalBatches` function can expired withdrawal requests be repaid.  

This also breaks the invariant:
*Assets are only paid to newer withdrawal batches if the market has sufficient assets to close older batches.*

Therefore, the following situations may occur:
1. Alice initiated a withdrawal request, but the borrower did not repay in time, causing this batch of withdrawal requests to expire.
2. The `borrower` calls the `repay` function or directly sends assets to the market contract. Since there are no new withdrawal batches, the assets remain in the contract.
3. Bob creates a new batch of withdrawal requests. The funds transferred by the borrower in the previous step are used to fulfill the new batch of withdrawal requests, while the expired withdrawal requests remain unpaid.

## Recommended Mitigation Steps
Modify the `_getUpdatedState` function to prioritize repaying expired batches with available assets.

```diff
  function _getUpdatedState() internal returns (MarketState memory state) {
    state = _state;
+   if (_withdrawalData.unpaidBatches.length() != 0) {
+       uint256 availableLiquidity = totalAssets() -
+         (state.normalizedUnclaimedWithdrawals + state.accruedProtocolFees);
+       uint256 numBatches = MathUtils.min(maxBatches, _withdrawalData.unpaidBatches.length());
+
+       uint256 i;
+       // Process up to `maxBatches` unpaid batches while there is available liquidity
+       while (i++ < numBatches && availableLiquidity > 0) {
+           // Process the next unpaid batch using available liquidity
+           uint256 normalizedAmountPaid = _processUnpaidWithdrawalBatch(state, availableLiquidity);
+           // Reduce liquidity available to next batch
+           availableLiquidity = availableLiquidity.satSub(normalizedAmountPaid);
+       }
+   } 
    // Handle expired withdrawal batch
    if (state.hasPendingExpiredBatch()) {
      uint256 expiry = state.pendingWithdrawalExpiry;
      // Only accrue interest if time has passed since last update.
      // This will only be false if withdrawalBatchDuration is 0.
      uint32 lastInterestAccruedTimestamp = state.lastInterestAccruedTimestamp;
      if (expiry != lastInterestAccruedTimestamp) {
        (uint256 baseInterestRay, uint256 delinquencyFeeRay, uint256 protocolFee) = state
          .updateScaleFactorAndFees(
            delinquencyFeeBips,
            delinquencyGracePeriod,
            expiry
          );
        emit_InterestAndFeesAccrued(
          lastInterestAccruedTimestamp,
          expiry,
          state.scaleFactor,
          baseInterestRay,
          delinquencyFeeRay,
          protocolFee
        );
      }
      _processExpiredWithdrawalBatch(state);
    }
    uint32 lastInterestAccruedTimestamp = state.lastInterestAccruedTimestamp;
    // Apply interest and fees accrued since last update (expiry or previous tx)
    if (block.timestamp != lastInterestAccruedTimestamp) {
      (uint256 baseInterestRay, uint256 delinquencyFeeRay, uint256 protocolFee) = state
        .updateScaleFactorAndFees(
          delinquencyFeeBips,
          delinquencyGracePeriod,
          block.timestamp
        );
      emit_InterestAndFeesAccrued(
        lastInterestAccruedTimestamp,
        block.timestamp,
        state.scaleFactor,
        baseInterestRay,
        delinquencyFeeRay,
        protocolFee
      );
    }

    // If there is a pending withdrawal batch which is not fully paid off, set aside
    // up to the available liquidity for that batch.
    if (state.pendingWithdrawalExpiry != 0) {
      uint32 expiry = state.pendingWithdrawalExpiry;
      WithdrawalBatch memory batch = _withdrawalData.batches[expiry];
      if (batch.scaledAmountBurned < batch.scaledTotalAmount) {
        // Burn as much of the withdrawal batch as possible with available liquidity.
        uint256 availableLiquidity = batch.availableLiquidityForPendingBatch(state, totalAssets());
        if (availableLiquidity > 0) {
          _applyWithdrawalBatchPayment(batch, state, expiry, availableLiquidity);
          _withdrawalData.batches[expiry] = batch;
        }
      }
    }
  }

```



## Assessed type

Other