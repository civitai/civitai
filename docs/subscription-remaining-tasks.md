# Subscription Multi-BuzzType - Remaining Tasks

## Summary of Completed Work

### ✅ Database
- Migration applied: `CustomerSubscription` supports `buzzType` field
- Composite unique constraint on `[userId, buzzType]`

### ✅ Backend Services
- `subscriptions.service.ts`:
  - `getPlans()` filters by buzzType
  - `getUserSubscription()` accepts buzzType parameter
- `creator-program.service.ts`:
  - Membership checks filter by buzzType
  - User cap cache queries by buzzType

### ✅ API Layer
- Schema updated to include buzzType
- Router passes buzzType
- Controller uses buzzType

### ✅ Frontend Components
- `MembershipPlans.tsx` - Passes selectedBuzzType to getPlans
- `GreenMembershipPlans.tsx` - Passes 'green' to getPlans
- Products now filtered by buzzType on pricing pages

## 🚧 Remaining Tasks

### 1. Session Management (HIGH PRIORITY)

**Current Problem:**
- Session stores single `tier` and `isMember` flag
- Derived from single subscription
- Doesn't support multiple subscriptions per buzzType

**Required Changes:**

#### Update Session Structure
File: `src/server/auth.ts` or wherever session is built

```typescript
// Current
interface SessionUser {
  tier?: string;
  isMember: boolean;
  subscriptionId?: string;
}

// Needed
interface SessionUser {
  tier?: string; // Highest tier across all subscriptions
  isMember: boolean; // Has any active membership
  subscriptionId?: string; // Keep for backward compat
  subscriptions?: {
    [buzzType: string]: {
      tier: string;
      isMember: boolean;
      subscriptionId: string;
    }
  }
}
```

#### Update Auth Callback
Need to query ALL user subscriptions and populate session properly:

```typescript
// Pseudo-code for auth callback
const subscriptions = await dbWrite.customerSubscription.findMany({
  where: {
    userId,
    status: 'active',
    currentPeriodEnd: { gt: new Date() }
  },
  include: { product: true }
});

// Build subscriptions object per buzzType
const subscriptionsByBuzzType = {};
let highestTier = 'free';
for (const sub of subscriptions) {
  const meta = sub.product.metadata as SubscriptionProductMetadata;
  subscriptionsByBuzzType[sub.buzzType] = {
    tier: meta.tier,
    isMember: true,
    subscriptionId: sub.id
  };
  // Update highestTier logic
}

// Add to session
session.user.subscriptions = subscriptionsByBuzzType;
session.user.tier = highestTier;
session.user.isMember = Object.keys(subscriptionsByBuzzType).length > 0;
```

### 2. Frontend Subscription Hooks (HIGH PRIORITY)

**Files to Update:**
- `src/components/Stripe/memberships.util.ts`

#### Update `useActiveSubscription` Hook

**Current:**
```typescript
export const useActiveSubscription = () => {
  const { data: subscription } = trpc.subscriptions.getUserSubscription.useQuery();
  // ...
}
```

**Needed:**
```typescript
// Option 1: Support buzzType parameter
export const useActiveSubscription = ({
  checkWhenInBadState,
  buzzType
}: {
  checkWhenInBadState?: boolean;
  buzzType?: string;
} = {}) => {
  const currentUser = useCurrentUser();

  // Get subscription for specific buzzType if provided
  // Otherwise default to current domain's buzzType or user's primary subscription
  const activeBuzzType = buzzType ?? useAvailableBuzz()[0];

  const { data: subscription } = trpc.subscriptions.getUserSubscription.useQuery(
    { buzzType: activeBuzzType },
    { enabled: !!currentUser }
  );
  // ...
}

// Option 2: Create new hooks
export const useSubscriptionForBuzzType = (buzzType: string) => { ... }
export const useAllUserSubscriptions = () => { ... }
export const useHasMembershipForBuzzType = (buzzType: string) => { ... }
```

#### Update All Hook Usages

Files using `useActiveSubscription`:
- `src/components/Purchase/GreenMembershipPlans.tsx` - Should pass buzzType: 'green'
- `src/components/Purchase/MembershipPlans.tsx` - Should pass buzzType based on selection
- `src/pages/user/membership.tsx` - Needs to show ALL subscriptions
- `src/pages/user/buzz-dashboard.tsx`
- `src/components/Account/SubscriptionCard.tsx`
- And 15+ other files...

### 3. User Membership Page (MEDIUM PRIORITY)

**File:** `src/pages/user/membership.tsx`

**Current Behavior:**
- Shows single subscription
- Manages single subscription (cancel/upgrade)

**Needed Behavior:**
- Show ALL active subscriptions per buzzType
- Group subscriptions by buzzType
- Allow managing each subscription independently
- Show which subscription is for which domain (yellow/green)

**UI Mockup:**
```
Your Memberships

┌─────────────────────────────────────┐
│ 🟡 Yellow Buzz Membership           │
│ Gold Tier - $10/month               │
│ [Manage] [Cancel]                   │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│ 🟢 Green Buzz Membership            │
│ Silver Tier - $5/month              │
│ [Manage] [Cancel]                   │
└─────────────────────────────────────┘
```

### 4. Stripe/Paddle Webhook Handlers (HIGH PRIORITY)

**Files:**
- `src/server/services/stripe.service.ts`
- `src/server/services/paddle.service.ts`
- `src/pages/api/webhooks/paddle.ts`
- `src/pages/api/webhooks/stripe.ts`

**Required Changes:**
- Ensure webhooks use `buzzType` from product metadata when creating subscriptions
- Update subscription upsert logic to use composite key
- Handle multiple active subscriptions per user

**Example:**
```typescript
// When webhook creates/updates subscription
const productMeta = product.metadata as SubscriptionProductMetadata;
const buzzType = productMeta.buzzType ?? 'yellow';

await dbWrite.customerSubscription.upsert({
  where: {
    userId_buzzType: {
      userId: user.id,
      buzzType
    }
  },
  create: {
    userId: user.id,
    buzzType,
    // ... other fields
  },
  update: {
    // ... update fields
  }
});
```

### 5. Subscription Router/Controller Updates

**File:** `src/server/controllers/subscriptions.controller.ts`

**getUserSubscriptionHandler:**
```typescript
export const getUserSubscriptionHandler = async ({ ctx, input }: { ctx: Context; input?: { buzzType?: string } }) => {
  if (!ctx.user?.id) return null;

  // Get subscription for specific buzzType from input, or use domain default
  const buzzType = input?.buzzType ?? getDomainBuzzType(ctx);

  return await getUserSubscription({
    userId: ctx.user.id,
    buzzType
  });
};
```

**Router:**
```typescript
getUserSubscription: protectedProcedure
  .input(z.object({ buzzType: z.string().optional() }).optional())
  .query(getUserSubscriptionHandler),
```

### 6. Helper Functions to Create

**File:** `src/server/services/subscriptions.service.ts`

```typescript
// Get all active subscriptions for a user
export async function getAllUserSubscriptions(userId: number) {
  return await dbWrite.customerSubscription.findMany({
    where: {
      userId,
      status: 'active',
      currentPeriodEnd: { gt: new Date() }
    },
    include: {
      product: true,
      price: true
    }
  });
}

// Check if user has active membership for specific buzzType
export async function hasActiveMembershipForBuzzType(userId: number, buzzType: string) {
  const subscription = await getUserSubscription({ userId, buzzType });
  return !!subscription && subscription.status === 'active';
}

// Get user's tier for specific buzzType
export async function getUserTierForBuzzType(userId: number, buzzType: string) {
  const subscription = await getUserSubscription({ userId, buzzType });
  return subscription?.tier ?? 'free';
}
```

## Priority Order

1. **Session Management** - Blocking for everything else
2. **Webhook Handlers** - Critical for new subscriptions to work
3. **Frontend Hooks** - Needed for UI to function correctly
4. **User Membership Page** - User experience improvement
5. **Helper Functions** - Nice to have, improves code quality

## Testing Checklist

- [ ] User can subscribe to yellow buzz membership
- [ ] User can subscribe to green buzz membership
- [ ] User can have BOTH subscriptions simultaneously
- [ ] Session reflects correct membership status per buzzType
- [ ] Creator program checks membership for correct buzzType
- [ ] Pricing page shows only relevant plans per domain
- [ ] Membership page shows all subscriptions
- [ ] Webhooks create subscriptions with correct buzzType
- [ ] Canceling one subscription doesn't affect the other
- [ ] Upgrading/downgrading works per buzzType

## Notes

- Consider backward compatibility for existing single subscriptions
- Add migration period where old code still works
- Log warnings when buzzType is not specified
- Document API changes for external consumers
