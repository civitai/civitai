# Prepaid Token Unlock System — Design Document

## Overview

Overhaul the prepaid membership system so that instead of Civitai automatically delivering Buzz on behalf of users, tokens are **unlocked** on schedule and users **claim** them manually.

---

## Current System (How It Works Today)

### Redemption Flow
1. User redeems a membership code (e.g., 6-month Silver `MB-XXXX-XXXX`)
2. Service creates/updates a `CustomerSubscription` record
3. First month's buzz is delivered **immediately**
4. Remaining months stored as `metadata.prepaids.silver = 5`

### Automatic Delivery (Daily Jobs)
- **`deliverPrepaidMembershipBuzz`** (1 AM UTC): Checks if `currentPeriodStart` day-of-month matches today and `prepaids[tier] > 0`. If so, delivers buzz and decrements.
- **`processPrepaidMembershipTransitions`** (midnight): When `currentPeriodEnd` is reached, transitions to next available tier from prepaids.
- **`cancelExpiredPrepaidMemberships`** (2 AM): Safety net cancellation for expired subscriptions.

### Problem
Civitai decides **when** to deliver buzz and **spends tokens automatically**. Users have no visibility or control over this process.

---

## Proposed System

### Core Concept
- Tokens are **unlocked** on schedule (same cadence as today)
- Users **claim** unlocked tokens to receive their Buzz
- Unclaimed tokens remain available until claimed (no expiration for now)

### Token Lifecycle

```
[LOCKED] → (unlock date reached) → [UNLOCKED] → (user claims) → [CLAIMED]
```

### Key Changes

| Area | Current | Proposed |
|------|---------|----------|
| Monthly delivery | Auto-delivers Buzz | Job marks token as `unlocked` |
| User action | None (passive) | User clicks "Claim" to receive Buzz |
| Visibility | Timeline + transaction history | Token list with status (locked/unlocked/claimed) |
| First month | Auto-delivered on redemption | First token created as `unlocked` immediately |
| Token history | Stored in `buzzTransactionIds` array | Full token records with status, dates, tier |

---

## Data Model

### New: `PrepaidToken` (stored in `CustomerSubscription.metadata.tokens`)

Each token is a discrete record representing one month of membership Buzz:

```typescript
interface PrepaidToken {
  id: string;              // Unique ID (e.g., "tok_" + nanoid)
  tier: 'bronze' | 'silver' | 'gold';
  status: 'locked' | 'unlocked' | 'claimed';
  buzzAmount: number;      // e.g., 10000, 25000, 50000
  codeId?: string;         // The redeemable code this token came from (for traceability)
  unlockDate: string;      // ISO date — when this token becomes claimable
  claimedAt?: string;      // ISO date — when the user claimed it
  buzzTransactionId?: string; // The external transaction ID after claiming
}
```

### Updated `SubscriptionMetadata`

```typescript
interface SubscriptionMetadata {
  // REMOVED: prepaids, proratedDays, buzzTransactionIds
  // ADDED:
  tokens: PrepaidToken[];

  // KEPT:
  renewalEmailSent?: boolean;
  cancellationReason?: string;
}
```

@dev: Note that we're replacing the `prepaids` counter with discrete token objects. This gives us full history and per-token status tracking. The tradeoff is more metadata size, but a 12-month membership is only ~12 token objects (~2KB JSON) so this should be fine.

### Why metadata instead of a new DB table?

- Token data is only relevant for display on the membership page
- No need to query tokens across users (admin can use subscription metadata)
- Avoids schema migration complexity
- Keeps the system self-contained within the subscription record
- If we ever need cross-user queries, we can migrate to a table later

@ai:* Confirmed: metadata approach. We'll keep the structure as close to the existing `prepaids` format as possible to minimize migration complexity. Existing data will need migrating from `prepaids` counters → token arrays.

---

## Redemption Changes

### `consumeRedeemableCode` (redeemableCode.service.ts)

**New user (no existing membership):**
1. Create subscription as today
2. Instead of granting buzz immediately + setting `prepaids[tier] = N-1`:
   - Create `N` token objects
   - First token: `status: 'unlocked'`, `unlockDate: now`
   - Remaining tokens: `status: 'locked'`, `unlockDate: now + 1mo, now + 2mo, ...`
3. No immediate buzz delivery — user must claim their first unlocked token

@ai:* Corrected: NO auto-claim. First token is created as `unlocked` on redemption, but the user must manually claim it on the membership page. Never auto-claim — the point is user agency.

**Same tier extension:**
1. Calculate unlock dates continuing from last existing token's unlock date
2. Create `N` new locked tokens appended to `metadata.tokens`

**Tier upgrade:**
1. Create `N` new tokens for the new tier
2. First token: `unlocked` immediately
3. Existing locked tokens from old tier remain as-is (they'll unlock on schedule at their original tier/buzz amount)

**Tier downgrade:**
1. Create `N` new tokens for the lower tier
2. All `locked` — unlock dates start after current membership period ends
3. Existing tokens from current tier remain unchanged

---

## Job Changes

### `deliverPrepaidMembershipBuzz` → `unlockPrepaidTokens`

**Before:** Delivers buzz, decrements `prepaids[tier]`
**After:** Finds tokens where `status === 'locked'` AND `unlockDate <= today`, sets `status = 'unlocked'`

```typescript
// Pseudocode
const subscription = await getActiveSubscription(userId);
const tokens = subscription.metadata.tokens;
const today = dayjs().startOf('day');

let changed = false;
for (const token of tokens) {
  if (token.status === 'locked' && dayjs(token.unlockDate).isSameOrBefore(today)) {
    token.status = 'unlocked';
    changed = true;
  }
}

if (changed) {
  await updateSubscriptionMetadata(subscription.id, { tokens });
  // Optionally: send notification to user about newly unlocked tokens
}
```

### `processPrepaidMembershipTransitions`

Logic stays largely the same but instead of checking `prepaids[tier] > 0`, it checks for tokens with `status !== 'claimed'` for any tier. The subscription's active product/tier is determined by the **first unclaimed token's tier** (or the most recent claimed token's tier if all unlocked are claimed).

@ai:* Confirmed: tier transition logic stays the same. Still prioritize best available tier (gold > silver > bronze), but instead of delivering buzz, unlock the next token from that tier.

### `cancelExpiredPrepaidMemberships`

Updated condition: Cancel when `currentPeriodEnd <= now` AND no remaining `locked` or `unlocked` tokens exist.

---

## New: Claim Token Endpoint

### Router: `subscription.claimPrepaidToken`

```typescript
input: { tokenId: string }
```

**Logic:**
1. Fetch user's active Civitai subscription
2. Find token by `id` in `metadata.tokens`
3. Validate: `status === 'unlocked'` (not locked, not already claimed)
4. Create buzz transaction:
   - `fromAccountId: 0` (system)
   - `toAccountId: userId`
   - `amount: token.buzzAmount`
   - `type: TransactionType.Redeemable`
   - `externalTransactionId: prepaid-token-claim:{tokenId}`
5. Update token:
   - `status: 'claimed'`
   - `claimedAt: now`
   - `buzzTransactionId: externalTransactionId`
6. Save updated metadata
7. Invalidate caches

### Router: `subscription.claimAllPrepaidTokens`

Convenience endpoint to claim all `unlocked` tokens in one action.

---

## Membership Page UI Changes

### Plan Card Section (existing)
- No changes to plan name, badge, price display
- Add **token summary** below the plan card:

```
┌─────────────────────────────────────────────────┐
│  🔓 3 tokens ready to claim    [Claim All]      │
│  🔒 9 tokens locked — next unlock: Apr 15, 2026 │
└─────────────────────────────────────────────────────┘
```

### Token Overview Section (replaces Prepaid Timeline)

Shows a clear breakdown of all tokens:

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Membership Tokens                          12 total       │
│                                                                 │
│  ⚡ 3 Unlocked — ready to claim          75,000 Buzz  [Claim]  │
│  🔒 7 Locked — next unlock: Apr 15, 2026                       │
│  ✓  2 Claimed                             50,000 Buzz          │
│                                                                 │
│  ┌─ Token History ──────────────────────────────────────┐       │
│  │  Date          Tier     Amount    Status              │       │
│  │  Mar 15, 2026  Silver   25,000    ✓ Claimed           │       │
│  │  Feb 15, 2026  Silver   25,000    ✓ Claimed           │       │
│  │  Jan 15, 2026  Silver   25,000    🔓 Ready to claim   │       │
│  │  Dec 15, 2025  Silver   25,000    🔓 Ready to claim   │       │
│  │  Nov 15, 2025  Silver   25,000    🔓 Ready to claim   │       │
│  │  Oct 15, 2025  Gold     50,000    🔒 Unlocks Apr 15   │       │
│  │  ...                                                   │       │
│  └────────────────────────────────────────────────────────┘       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Key UI Principles
- **Unlocked tokens are prominent** — golden/yellow highlight with claim button
- **Locked tokens show countdown** — when they unlock next
- **Claimed tokens are muted** — checkmark, gray, shows date claimed
- **Mixed tiers are clearly labeled** — each token shows its tier badge (Bronze/Silver/Gold)
- **Claim All** button for convenience when multiple tokens are unlocked

---

## Migration Plan

### Phase 1: Data Migration
- Write a migration script that converts existing `metadata.prepaids` to token arrays
- For each `prepaids[tier] = N`:
  - Create N tokens with `status: 'locked'`
  - Calculate unlock dates based on `currentPeriodStart` day-of-month
  - For tokens whose unlock date is in the past: set `status: 'unlocked'`
- Convert existing `buzzTransactionIds` entries to `claimed` tokens with matching dates

### Phase 2: Job Updates
- Update `deliverPrepaidMembershipBuzz` → `unlockPrepaidTokens`
- Update `processPrepaidMembershipTransitions` to use token-based logic
- Update `cancelExpiredPrepaidMemberships` to check token status

### Phase 3: API & UI
- Add `claimPrepaidToken` and `claimAllPrepaidTokens` endpoints
- Update membership page with new token UI
- Update `PrepaidTimelineProgress` → new token overview component
- Update `PrepaidBuzzTransactions` → new token history component

### Phase 4: Redemption Updates
- Update `consumeRedeemableCode` to create token objects instead of incrementing counters
- Update tests

### Backwards Compatibility
- Keep reading `prepaids` as fallback during transition
- Migration script handles existing users
- New code only writes token format

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/server/services/redeemableCode.service.ts` | Token creation on redemption |
| `src/server/jobs/prepaid-membership-jobs.ts` | Unlock instead of deliver |
| `src/server/schema/subscriptions.schema.ts` | Add `PrepaidToken` type, update metadata schema |
| `src/server/routers/subscriptions.router.ts` | Add claim endpoints |
| `src/server/services/subscriptions.service.ts` | Claim logic |
| `src/pages/user/membership.tsx` | Updated UI sections |
| `src/components/Subscriptions/PrepaidTimelineProgress.tsx` | Replace with token overview |
| `src/components/Subscriptions/PrepaidBuzzTransactions.tsx` | Replace with token history |
| `src/hooks/useNextBuzzDelivery.ts` | Update to use token unlock dates |
| `src/server/jobs/__tests__/prepaid-membership-jobs.test.ts` | Updated tests |
| `src/server/services/__tests__/redeemableCode.service.test.ts` | Updated tests |

---

## Resolved Decisions

1. ~~**Auto-claim first token on redemption?**~~ → **No.** Never auto-claim. First token is `unlocked` on redemption, user claims it themselves on the membership page.
2. ~~**Metadata vs table?**~~ → **Metadata.** Keep structure close to current. Migrate existing data.
3. ~~**Tier transition logic?**~~ → **Same as today.** Prio best tier, unlock instead of deliver.
4. ~~**Token expiration?**~~ → **No expiration.** Unclaimed tokens stay available indefinitely.
5. ~~**Notifications?**~~ → **Yes, push email.** Drive users back to the site to claim.
6. ~~**Bulk claim UX?**~~ → **Yes, "Claim All" button.** Plus individual claim per token.
7. ~~**Prorated days?**~~ → **Prorated days are for membership benefits only, not tokens.** Keep the prorated days system for tier-level access duration, but no buzz is delivered for prorated time. Tokens are always full months.
