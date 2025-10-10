# Subscription Multi-Buzz Type Migration Plan

## Overview
Enable users to have multiple subscriptions (one per buzz type) instead of the current single subscription per user.

## Current State

### Database Schema
- `CustomerSubscription` table has `userId` with `@unique` constraint
- This prevents users from having multiple subscriptions
- Products already have `buzzType` in their metadata (yellow, green, blue, red)

### Code Dependencies
- Creator program checks for active membership
- Subscription queries assume single subscription per user
- User tier is derived from product metadata `tier` field

## Migration Strategy

### Phase 1: Database Schema Changes

#### 1. Remove Unique Constraint on userId
```prisma
model CustomerSubscription {
  id                 String    @id
  userId             Int       // Remove @unique
  user               User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  buzzType           String    // Add new field
  // ... rest of fields

  @@unique([userId, buzzType]) // New composite unique constraint
}
```

**Migration Steps:**
1. Add `buzzType` column (nullable first for existing data)
2. Backfill existing subscriptions with buzzType from product metadata
3. Add composite unique constraint on `[userId, buzzType]`
4. Make `buzzType` non-nullable
5. Drop old `userId` unique constraint

#### 2. Migration Script Considerations
- Existing subscriptions need to be assigned a buzzType
- Default to 'yellow' for existing subscriptions
- Use product metadata `buzzType` if available

### Phase 2: Code Updates

#### 1. Creator Program Service Updates

**Current:**
```typescript
const activeMembership = await dbWrite.customerSubscription.findFirst({
  where: {
    userId,
    status: 'active',
    currentPeriodEnd: { gt: new Date() },
  },
});
```

**Updated:**
```typescript
const activeMembership = await dbWrite.customerSubscription.findFirst({
  where: {
    userId,
    buzzType, // Filter by specific buzz type
    status: 'active',
    currentPeriodEnd: { gt: new Date() },
  },
});
```

**Files to Update:**
- `src/server/services/creator-program.service.ts`
  - `bankBuzz()` - Check membership for specific buzzType
  - `userCapCache` lookupFn - Filter subscriptions by buzzType
  - `getCreatorRequirements()` - May need to accept buzzType parameter

#### 2. Subscription Service Updates

**Files to Update:**
- `src/server/services/subscriptions.service.ts`
  - `getUserSubscription()` - Add buzzType parameter
  - All queries that fetch subscriptions need buzzType filter

#### 3. User Service Updates

**Files to Update:**
- `src/server/services/user.service.ts`
  - Update tier derivation to consider buzzType
  - May need helper: `getUserTierForBuzzType(userId, buzzType)`

#### 4. Stripe/Paddle Service Updates

**Files to Update:**
- `src/server/services/stripe.service.ts`
- `src/server/services/paddle.service.ts`
- Need to handle multiple active subscriptions per user
- Product metadata already contains `buzzType`

#### 5. Frontend Updates

**Files to Update:**
- `src/components/Subscriptions/*.tsx`
- Membership management UI needs to show multiple subscriptions
- Each subscription card should display its buzzType
- Allow managing each subscription independently

### Phase 3: Creator Program Integration

#### 1. Membership Checks per BuzzType

Update functions that check membership:
- `bankBuzz(userId, amount, buzzType)` - Check membership for that buzzType
- `getCreatorRequirements(userId, buzzType?)` - Get requirements per buzzType or aggregate

#### 2. Cap Calculations per BuzzType

- `userCapCache` already separated by buzzType
- Ensure tier lookup considers correct buzzType subscription

### Phase 4: Backward Compatibility

#### 1. Helper Functions
Create helpers for common patterns:
```typescript
// Get user's subscription for specific buzzType
async function getUserSubscriptionForBuzzType(userId: number, buzzType: BuzzSpendType)

// Get user's tier for specific buzzType
async function getUserTierForBuzzType(userId: number, buzzType: BuzzSpendType)

// Check if user has active membership for buzzType
async function hasActiveMembershipForBuzzType(userId: number, buzzType: BuzzSpendType)

// Get all active subscriptions for user
async function getUserActiveSubscriptions(userId: number)
```

#### 2. Migration Period Support
- Existing code that doesn't pass buzzType should default to yellow
- Log warnings when buzzType is not specified
- Phase out over time

## Implementation Order

1. ✅ **Database Migration** (highest priority)
   - Add buzzType column
   - Backfill data
   - Add composite constraint
   - Remove old constraint

2. **Core Service Updates**
   - Update subscription queries with buzzType filter
   - Add helper functions
   - Update creator program membership checks

3. **Payment Provider Updates**
   - Stripe subscription handling
   - Paddle subscription handling
   - Ensure product metadata buzzType is used

4. **Frontend Updates**
   - Subscription management UI
   - Display multiple subscriptions
   - Creator program UI (already done)

5. **Testing & Validation**
   - Test multiple subscriptions per user
   - Test creator program with different buzzTypes
   - Test subscription upgrades/downgrades

## Additional Considerations from Review

### Session Management
**Current State:**
- Session stores single tier and `isMember` status
- Derived from single subscription

**Required Changes:**
```typescript
// Current session
interface Session {
  tier: string;
  isMember: boolean;
}

// New session structure
interface Session {
  subscriptions: {
    [buzzType: string]: {
      tier: string;
      isMember: boolean;
    }
  }
  // Helper computed properties for backward compatibility
  tier: string; // Highest tier across all subscriptions
  isMember: boolean; // Has any active membership
}
```

### Subscription Hooks
**Files to Update:**
- `src/hooks/useCurrentUser.ts` - Access subscription by buzzType
- `src/components/Stripe/memberships.util.ts` - Update hooks
- Need hooks like:
  - `useSubscriptionForBuzzType(buzzType)`
  - `useAllUserSubscriptions()`
  - `useHasMembershipForBuzzType(buzzType)`

### Pricing Page
**Files to Update:**
- `src/pages/pricing/index.tsx`
- `src/components/Purchase/MembershipPlans.tsx`
- `src/components/Purchase/GreenMembershipPlans.tsx`

**Changes Needed:**
- Filter products by domain buzzType
- Show only yellow buzz subscriptions on main domain
- Show only green buzz subscriptions on green domain
- Display current subscription status per buzzType

## Risks & Considerations

1. **Data Migration**
   - Existing subscriptions must be correctly assigned buzzType
   - Need to validate product metadata has buzzType

2. **Multiple Active Subscriptions**
   - Users could have multiple active subscriptions
   - Billing implications need consideration
   - UI needs to clearly show which subscription is for what

3. **Creator Program**
   - Cap calculations per buzzType
   - Banking requires active membership for that buzzType
   - Need clear messaging to users

4. **Payment Providers**
   - Ensure they handle multiple subscriptions correctly
   - Webhooks need to handle multiple subscriptions
   - Cancellation/changes need to target correct subscription

## Rollout Strategy

1. **Week 1**: Database migration + basic service updates
2. **Week 2**: Payment provider updates + testing
3. **Week 3**: Frontend updates + extensive testing
4. **Week 4**: Gradual rollout with monitoring

@dev: Please review this plan. Key questions:
1. Should we support multiple subscriptions immediately or phase it in?
2. What should be the default buzzType for existing subscriptions?
3. Do we want users to be able to have multiple active subscriptions or just one at a time?
