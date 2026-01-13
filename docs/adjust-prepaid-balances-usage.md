# Prepaid Membership Balance Adjustment Script

## Overview

This script retroactively adjusts prepaid membership balances that were incorrectly maintained due to a bug in the `deliverPrepaidMembershipBuzz` job (fixed in commit [58538e5bf](https://github.com/civitai/civitai/commit/58538e5bf6cf26ba44d6f4b4b813ba4121d2c11d)).

## The Problem

The bug caused the job to use `userId` instead of `subscriptionId` when decrementing prepaid balances, which could update the wrong subscription when users had multiple subscriptions. This resulted in:
- Some users receiving extra monthly buzz beyond what they paid for
- Incorrect prepaid balances that don't align with subscription end dates

## The Solution

The script handles two distinct scenarios:

### Scenario 1: Normal Case (No Rollover)
When `currentPeriodEnd` ≤ `expected_end_date`:
- **Action**: Set prepaid balance to match months remaining from today to currentPeriodEnd
- **Example**: User has 2 months prepaid, 3 months remaining → adjust to 3

### Scenario 2: Rollover Case (Extra Months Already Granted)
When `currentPeriodEnd` > `expected_end_date`:
- **Action**: Set prepaid balance to 0 to prevent more monthly buzz deliveries
- **Reason**: User already received extra months they didn't pay for
- **Example**: User redeemed 3-month code on 2025-10-01, expected end 2026-01-01, but currentPeriodEnd is 2026-04-02 → set prepaid to 0

## Usage

### Endpoint
```
POST /api/admin/temp/adjust-prepaid-balances
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dryRun` | boolean | `true` | Preview changes without applying them |
| `userId` | number | - | Optional: Target specific user |

### Examples

#### 1. Dry Run (Preview All Changes)
```bash
curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=true"
```

#### 2. Dry Run for Specific User
```bash
curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=true&userId=221332"
```

#### 3. Execute Changes for Specific User
```bash
curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=false&userId=221332"
```

#### 4. Execute All Changes (PRODUCTION)
```bash
curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=false"
```

## Response Format

```json
{
  "success": true,
  "dryRun": true,
  "summary": {
    "totalAffected": 150,
    "totalProcessed": 150,
    "rolloverCases": 65,
    "normalCases": 85,
    "totalIncreases": 45,
    "totalDecreases": 105,
    "byTier": {
      "bronze": 80,
      "silver": 60,
      "gold": 10
    },
    "failedUpdates": 0
  },
  "details": [
    {
      "subscriptionId": "sub_xxx",
      "userId": 221332,
      "tier": "silver",
      "previousBalance": 18,
      "newBalance": 0,
      "adjustment": -18,
      "isRolloverCase": true,
      "extraMonthsRolled": 7,
      "success": true
    }
  ]
}
```

## Test Cases

Based on examples from `prepaid-examples.json`:

### Rollover Cases (Set to 0)

#### 1. userId 221332
- **Scenario**: User bought 12-month sub on 2025-05-20, then redeemed 12-month code on 2025-10-07
- **Expected end**: 2026-10-07
- **Actual end**: 2027-05-20 (7 extra months rolled over)
- **Current prepaid**: 18 months
- **Adjustment**: Set to 0 (not 16)
- **Reason**: Already received 7 extra months, cap benefit here

#### 2. userId 9846793
- **Scenario**: Redeemed 3-month code on 2025-10-01
- **Expected end**: 2026-01-01
- **Actual end**: 2026-04-02 (3 extra months rolled over)
- **Current prepaid**: 1 month
- **Adjustment**: Set to 0
- **Reason**: Already received extra months beyond what was paid for

### Normal Cases (Match Remaining Months)

#### 3. userId 6198670
- **Scenario**: Redeemed 3x 3-month codes (9 months total)
- **Expected end**: 2026-04-15
- **Actual end**: 2026-04-15 (no rollover)
- **Current prepaid**: 2 months
- **Months remaining**: 3 months
- **Adjustment**: Set to 3

#### 4. userId 3800195
- **Scenario**: Redeemed 2x 3-month bronze codes
- **Expected end**: 2026-04-26
- **Actual end**: 2026-04-26 (no rollover)
- **Current prepaid**: 2 months
- **Months remaining**: 3 months
- **Adjustment**: Set to 3

## Execution Plan

1. **Phase 1 - Dry Run**: Execute with `dryRun=true` to preview all changes
   ```bash
   curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=true" > preview.json
   ```

2. **Phase 2 - Review**: Analyze the preview results
   - Check rolloverCases vs normalCases counts
   - Verify adjustment amounts make sense
   - Review any failed updates

3. **Phase 3 - Test Users**: Run on specific test users with `userId` parameter
   ```bash
   # Test rollover case
   curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=false&userId=221332"

   # Test normal case
   curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=false&userId=6198670"
   ```

4. **Phase 4 - Production**: Execute full run with `dryRun=false`
   ```bash
   curl -X POST "https://civitai.com/api/admin/temp/adjust-prepaid-balances?dryRun=false"
   ```

5. **Phase 5 - Verification**: Confirm all adjustments were applied correctly
   - Check prepaid balances in database
   - Verify no metadata corruption
   - Monitor buzz delivery job for correct behavior

## Safety Features

- **Dry run default**: Script always defaults to `dryRun=true`
- **Metadata preservation**: Never loses existing metadata fields
- **Batch processing**: Processes in batches with concurrency control
- **Comprehensive logging**: All operations logged with subscription IDs
- **Error handling**: Failed updates are tracked and reported

## Technical Details

### Query Logic

The script:
1. Joins CustomerSubscription with RedeemableCode to calculate expected_end_date
2. Compares currentPeriodEnd with expected_end_date to detect rollovers
3. Applies different logic based on rollover status
4. Calculates adjustment amounts for reporting

### Configuration

- `BATCH_SIZE`: 50 subscriptions per batch
- `CONCURRENCY`: 5 parallel batches

### What It Does NOT Do

- ❌ Modify currentPeriodEnd dates (always keeps existing end dates)
- ❌ Create new buzz transactions
- ❌ Cancel or activate subscriptions
- ❌ Modify subscription tiers or prices
- ❌ Touch buzzTransactionIds array

### What It DOES Do

- ✅ Update only the prepaid balance for the active tier
- ✅ Preserve all other metadata fields
- ✅ Set updatedAt timestamp
- ✅ Report all changes with detailed logging

## Database Impact

The script updates the `CustomerSubscription` table:
- Updates `metadata.prepaids[tier]` field
- Updates `updatedAt` timestamp
- No other fields are modified

## Rollback Plan

If you need to rollback changes:

1. **Identify affected subscriptions** from the execution response (save the `details` array)
2. **Restore previous values** using a similar script with the previous balances
3. **Verify** buzz delivery behavior returns to expected state

## Notes

- Script only processes active subscriptions with future currentPeriodEnd dates
- Subscriptions without redemption history are skipped (can't calculate expected_end_date)
- Subscriptions with currentPeriodEnd in the past are skipped
- Multi-tier subscriptions are handled (only active tier is adjusted)
