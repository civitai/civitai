# Prepaid Membership Test Suite Plan

**Status: ✅ IMPLEMENTED**
**Tests: All passing (see test output for count)**
**Run: `pnpm run test:unit:run`**

## Overview

This document outlines the test suite for the prepaid membership system, covering the redeemable code service, prepaid membership jobs, and related business logic.

## Problem Statement

We've encountered issues with prepaid memberships including:
- Prepaid credits not being properly consumed
- Users receiving buzz instantly instead of through the proper prepaid flow
- Token/month tracking issues

## Test Scope

### 1. Redeemable Code Service (`src/server/services/redeemableCode.service.ts`)

#### 1.1 Code Creation Tests
- [x] Creates codes with correct format (MB-XXXX-XXXX for membership, CS-XXXX-XXXX for buzz)
- [x] Creates specified quantity of codes
- [x] Validates priceId exists for membership codes
- [x] Stores correct unitValue and type

#### 1.2 Code Redemption Tests - New User (No Existing Membership)
- [x] Creates new CustomerSubscription record
- [x] Sets correct currentPeriodEnd based on unitValue and price interval
- [x] Sets prepaids metadata to `unitValue - 1` (first month granted immediately)
- [x] Grants immediate buzz based on product's monthlyBuzz
- [ ] Records externalTransactionId in buzzTransactionIds (future work)
- [x] Sets cancelAtPeriodEnd to true

#### 1.3 Code Redemption Tests - Same Tier Extension
- [x] Extends currentPeriodEnd correctly
- [x] Increments prepaids[tier] by full unitValue (no immediate buzz granted)
- [x] Does NOT grant immediate buzz (tokens saved for job delivery)
- [x] Does NOT append to buzzTransactionIds (no transaction created)

#### 1.4 Code Redemption Tests - Upgrade (Higher Tier)
- [x] Updates productId and priceId to new tier
- [ ] Calculates prorated days correctly from remaining lower tier (future work)
- [ ] Sets new currentPeriodStart and currentPeriodEnd (future work)
- [ ] Stores proratedDays for the old tier (future work)
- [x] Sets prepaids[newTier] to unitValue - 1 (first month granted immediately)
- [x] Grants immediate buzz for new tier

#### 1.5 Code Redemption Tests - Downgrade (Lower Tier)
- [x] Does NOT change productId or priceId (user stays on current tier)
- [x] Only updates metadata with prepaids for lower tier
- [x] Does NOT grant immediate buzz (all tokens saved as prepaids)
- [x] Does NOT extend currentPeriodEnd

#### 1.6 Edge Cases
- [x] Rejects already-redeemed codes (by different user)
- [x] Returns existing record for same-user re-redemption
- [ ] Rejects expired codes (future work)
- [x] Rejects codes without priceId for membership type
- [x] Rejects codes for non-Civitai provider products
- [ ] Handles provider mismatch (cannot redeem Civitai code on Stripe subscription) (future work)

### 2. Prepaid Membership Jobs (`src/server/jobs/prepaid-membership-jobs.ts`)

#### 2.1 Buzz Delivery Job (`deliverPrepaidMembershipBuzz`)
- [x] Selects only users with prepaids > 0 and grants buzz
- [x] Does NOT run if no membership holders found
- [x] Grants correct monthlyBuzz amount from product metadata
- [x] Decrements prepaids[tier] after granting buzz
- [x] Records externalTransactionId with correct format
- [x] Delivers cosmetics after buzz
- [x] Batch processes when many users found

#### 2.2 Membership Transition Job (`processPrepaidMembershipTransitions`)
- [x] Finds memberships expiring today
- [x] Selects highest available tier from prepaids when transitioning
- [x] Updates productId/priceId when tier changes
- [x] Sets new currentPeriodStart and currentPeriodEnd
- [x] Clears prepaid count for used tier after use
- [x] Cancels subscription when no prepaids remain
- [x] Does NOT process if no expiring memberships

#### 2.3 Expiration Job (`cancelExpiredPrepaidMemberships`)
- [x] Finds active memberships past currentPeriodEnd
- [x] Sets status to 'canceled' with canceledAt and endedAt
- [x] Refreshes user sessions after cancellation
- [x] Does NOT run if no expired memberships
- [x] Handles multiple expired memberships

### 3. Subscription Metadata Integrity

- [x] prepaids object maintains correct tier counts
- [ ] proratedDays accumulates correctly across upgrades (future work)
- [ ] buzzTransactionIds are never duplicated (future work)
- [ ] Metadata is valid JSON after all operations (future work)

### 4. Buzz Transaction Integrity

- [x] externalTransactionId format is consistent
- [ ] No duplicate transactions with same externalTransactionId (future work)
- [ ] Correct buzzType (yellow) for prepaid memberships (future work)
- [x] Amount matches product's monthlyBuzz

## Implementation Details

### Test Framework

Using **Vitest** for unit testing with:
- Mock implementations for database calls
- Mock implementations for buzz service
- Time mocking with `vi.useFakeTimers()`

### Test Files Structure

```
src/
└── __tests__/
    ├── setup.ts                          # Global test setup
    ├── mocks/
    │   ├── database.ts                   # Mock Prisma client
    │   └── services.ts                   # Mock external services
    └── server/
        ├── services/
        │   └── redeemableCode.service.test.ts
        └── jobs/
            └── prepaid-membership-jobs.test.ts
```

### Key Test Data

```typescript
// Tier hierarchy (lowest to highest)
const tierOrder = ['free', 'founder', 'bronze', 'silver', 'gold'];

// Monthly buzz values
const monthlyBuzz = {
  bronze: 10000,
  silver: 25000,
  gold: 50000,
};
```

## Success Criteria

1. All tests pass consistently
2. No false positives (tests that pass when they should fail)
3. Tests cover all critical paths identified in issues
4. Tests are maintainable and well-documented

## Future Considerations

- Integration tests with actual database (using test database)
- Performance tests for batch operations
- Add E2E Playwright tests for UI redemption flow
