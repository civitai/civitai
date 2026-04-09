# PR Review: Green Buzz Auction Support

## Overview

This PR adds green buzz support to auctions, allowing users on the green domain to bid using green buzz. Includes green-specific safety checks for recurring bids and environment-swap UI changes.

---

## Open Concerns

### 1. Bids from different domains are silently merged

Both `Bid` and `BidRecurring` merge bids across domains because their unique constraints don't account for buzz type.

#### `Bid` — no `accountType` column at all

**File:** [auction.service.ts:494-516](../src/server/services/auction.service.ts#L494-L516)

`Bid` has `@@unique([auctionId, userId, entityId])`. When a user bids on the same entity from .com (yellow buzz) and .red (green buzz), the second bid increments the first at line 501. The buzz transactions are correctly charged from the right account type, but the `Bid` row has no record of which portion came from which type.

Consequences:
- **Refunds are broken** — if the bid is refunded, there's no way to know how much to refund to yellow vs green
- The `transactionIds` array does reference both transactions, so the buzz service could theoretically reverse them individually, but the bid logic would need to handle this

**Fix:** Add an `accountType` column to `Bid` and include it in the unique constraint, so .com and .red bids are separate rows. Alternatively, if mixed-domain bids on the same entity are rare/unlikely, block the second bid with an error.

#### `BidRecurring` — `accountType` exists but isn't in the unique constraint

**File:** [auction.service.ts:554-574](../src/server/services/auction.service.ts#L554-L574)

`BidRecurring` has `@@unique([auctionBaseId, userId, entityId])`. The upsert matches on this, so a second bid from a different domain increments `amount` but doesn't update `accountType`. The recurring bid stays as whatever type was set first.

Consequences:
- Recurring charges use the wrong buzz account type
- If the original was yellow, the green safety re-validation won't fire

**Fix:** Add `accountType` to the unique constraint: `@@unique([auctionBaseId, userId, entityId, accountType])` and update the upsert `where` clause. The recurring bid job already iterates all rows, so it would handle multiple bids per user/entity naturally.

---

### 2. Orphaned green recurring bids retry indefinitely

**File:** [handle-auctions.ts:620-633](../src/server/jobs/handle-auctions.ts#L620-L633)

When a model version is deleted, the green safety check correctly skips the bid (`!mv`), but the recurring bid is never paused or deleted. It will be skipped on every job run indefinitely, generating a log line each time.

**Action:** Consider auto-pausing the recurring bid when the model version can't be found:
```ts
if (!mv) {
  await dbWrite.bidRecurring.update({
    where: { id: recurringBid.id },
    data: { isPaused: true },
  });
  log(`Paused recurring bid ${recurringBid.id}: model version not found`);
  continue;
}
```

---

### 3. Recurring bid re-validation is narrower than initial bid placement

**File:** [handle-auctions.ts:620-633](../src/server/jobs/handle-auctions.ts#L620-L633) vs [auction.service.ts:399-450](../src/server/services/auction.service.ts#L399-L450)

Initial `createBid` validates: model existence, availability, published status, `cannotPromote`, `poi`, model type, ecosystem, and green-specific NSFW/poi/minor.

The recurring bid re-validation for green only checks `nsfw`, `poi`, `minor`. Missing checks:
- `cannotPromote` meta flag
- Model `status` (could become unpublished after bid creation)
- Model `availability` (could become Private)
- Model type / ecosystem match

Yellow recurring bids have **zero** re-validation.

**Action:** Low priority — the initial placement enforces all rules, so this only matters if a model's properties change after the recurring bid is created. Consider at minimum re-checking published status.

---

## Verified Safe

- **Client cannot manipulate accountType** — derived server-side from `ctx.features` via `getAllowedAccountTypes`, not from user input
- **Green bids correctly charge green buzz** — `getAllowedAccountTypes` returns `['green']` for green domain
- **NSFW bids blocked on green** — both client-side (disabled button + error alert) and server-side validation in `createBid`
- **No SQL injection** — all queries use parameterized Prisma queries
- **Frontend is clean** — proper null checks, correct buzz type display, no state management issues
