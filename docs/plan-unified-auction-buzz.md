# Unified Auctions: Domain-Aware Buzz & Content Restrictions

**ClickUp:** https://app.clickup.com/t/868j5qh9q

## Problem

The auction system was hardcoded to only accept yellow buzz (`['yellow']`). With the multi-domain architecture (civitai.com uses yellow buzz, civitai.green uses green buzz), green-domain users could not participate in auctions at all — they only have green + blue buzz, and the system rejected anything other than yellow.

Additionally, auctions had no content safety filtering for the green domain. Since civitai.green is a safe-for-work site, models marked as NSFW, POI (person of interest), or minor should not be biddable from that domain.

## What Changed

### 1. Auctions are now enabled on the green domain

**File:** `src/server/services/feature-flags.service.ts`

The `auctions` feature flag was `['blue', 'red', 'public']` — green was excluded. Added `'green'` so the auction menu item appears and the API is accessible from civitai.green.

### 2. Buzz type is now domain-aware

Previously, the `createBid` service hardcoded `const accountTypes: BuzzSpendType[] = ['yellow']`. Now the **router** resolves the correct buzz type based on the user's domain using `getAllowedAccountTypes(ctx.features)` and passes it to the service as a parameter. The service itself has no knowledge of feature flags — it just receives and uses the account types it's given.

**Files:**
- `src/server/routers/auction.router.ts` — resolves `accountTypes` from `ctx.features`, passes to `createBid`
- `src/server/services/auction.service.ts` — accepts `accountTypes: BuzzSpendType[]` parameter, removed hardcoded `['yellow']`

### 3. Green domain cannot bid on restricted models

When `accountTypes` includes `'green'`, the `createBid` service now rejects bids on models where `model.nsfw`, `model.poi`, or `model.minor` is `true`. This is enforced server-side — the frontend also prevents the attempt but the backend is the authoritative gate.

**File:** `src/server/services/auction.service.ts`

```typescript
if (accountTypes.includes('green')) {
  if (mv.model.nsfw || mv.model.poi || mv.model.minor) {
    throw throwBadRequestError('Cannot bid on this content from this domain.');
  }
}
```

Note: models with NSFW *images* but `model.nsfw = false` are still biddable from green. Only the model-level flags block bidding.

### 4. Recurring bids store and use the domain's buzz type

The `BidRecurring` model now has an `accountType` column (`String`, defaults to `'yellow'`). When a recurring bid is created, the account type is stored. The daily recurring bid job (`handle-auctions.ts`) reads this stored value and uses it instead of the previously hardcoded `['yellow']`.

The job also re-validates content safety before each charge: if a model was reclassified as NSFW/POI/minor after the recurring bid was created, the bid is silently skipped rather than sponsoring restricted content.

**Files:**
- `prisma/schema.full.prisma` — added `accountType String @default("yellow")` to `BidRecurring`
- `prisma/migrations/20260407170238_add_account_type_to_bid_recurring/migration.sql` — migration
- `src/server/services/auction.service.ts` — stores `accountType` on recurring bid creation
- `src/server/jobs/handle-auctions.ts` — reads stored `accountType`, re-validates safety for green

### 5. Auction data now includes model safety flags

The `getAuctionMVData` query (used to hydrate bid placement data) now selects `nsfw`, `poi`, and `minor` from the model. This allows both the frontend and backend to make content decisions based on these flags.

**File:** `src/server/services/auction.service.ts` (model select in `getAuctionMVData`)

### 6. Frontend: placement cards and bid form respect green restrictions

**Placement cards** (`src/components/Auction/AuctionPlacementCard.tsx`):
- **Restricted models** (`model.nsfw/poi/minor`): the card shows "Not available on this site" in place of the image and model info. Position number and bid amount remain visible. The bid "+" button is hidden.
- **NSFW images on non-restricted models**: the image thumbnail is replaced with a placeholder icon. Model name and info are still shown. The model is fully biddable.
- **Safe content**: renders normally.

**Bid form** (`src/components/Auction/AuctionInfo.tsx`):
- When a restricted model is selected on green, the bid button is disabled and a red alert reads "This model is not available to bid on this site."
- The check uses `selectedModel.model.nsfw/poi/minor` from the `GenerationResource` type.

### 7. Buzz transaction button already works

`BuzzTransactionButton` internally calls `useAvailableBuzz()` which already resolves to `['green']` or `['yellow']` based on domain. No changes were needed for the buzz display or balance check in the bid form.

## Files Modified

| File | Change |
|------|--------|
| `prisma/schema.full.prisma` | Added `accountType String @default("yellow")` to `BidRecurring` |
| `prisma/migrations/20260407170238_.../migration.sql` | `ALTER TABLE` to add the column |
| `src/server/services/feature-flags.service.ts` | Added `'green'` to the `auctions` feature flag |
| `src/server/routers/auction.router.ts` | Resolves `accountTypes` from `ctx.features`, passes to `createBid` |
| `src/server/services/auction.service.ts` | Accepts `accountTypes` param; enforces nsfw/poi/minor gate for green; stores `accountType` on recurring bids; added nsfw/poi/minor to `getAuctionMVData` select |
| `src/server/jobs/handle-auctions.ts` | Uses stored `accountType` instead of hardcoded `['yellow']`; re-validates safety for green before charging |
| `src/components/Auction/AuctionPlacementCard.tsx` | Shows placeholder for restricted models on green; hides NSFW images on green; blocks bid button for restricted models |
| `src/components/Auction/AuctionInfo.tsx` | Disables bid form and shows alert for restricted models on green |

## Behavior Matrix (Green Domain)

| Condition | Image | Model Info | Biddable | Bid Button |
|-----------|-------|------------|----------|------------|
| `model.nsfw/poi/minor = true` | Hidden ("Not available on this site") | Hidden | No (backend rejects) | Hidden |
| `model.nsfw = false`, NSFW image | Placeholder icon | Shown | Yes | Shown |
| Everything safe | Shown | Shown | Yes | Shown |

On civitai.com (yellow domain), all models render and are biddable as before — no behavior change.

## Migration & Deployment Notes

- The `accountType` column has `@default("yellow")`, so all existing `BidRecurring` rows are automatically backfilled. No data migration script needed.
- The migration is additive-only (one new column with a default). Safe for zero-downtime deployment.
- Old code that doesn't reference `accountType` continues to work during rolling deploys.

## Testing Checklist

- [x] Green domain user can see the auctions page and menu item
- [x] Green domain user can bid on a safe model using green buzz
- [x] Green domain user cannot bid on a model with `nsfw = true` (backend rejects, UI prevents)
- [x] Green domain user cannot bid on a model with `poi = true` or `minor = true`
- [x] Restricted models show "Not available on this site" placeholder on green (position + amount visible)
- [x] Models with NSFW images but `nsfw = false` show image placeholder but are still biddable
- [x] Yellow domain (civitai.com) behavior is unchanged
- [ ] Recurring bid stores `accountType` correctly
- [ ] Recurring bid job charges the correct buzz type
- [ ] Recurring bid job skips charging if model became restricted after bid was created
- [ ] Refunds work correctly regardless of account type
