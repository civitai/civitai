# Plan: Add `accountType` to `Bid` for Multi-Domain Auction Support

## Context

Users should be able to bid with yellow buzz from .com and green buzz from .red on the same entity in the same auction. Currently, `Bid` has `@@unique([auctionId, userId, entityId])` with no `accountType` column, so bids from different domains silently merge into one row. `BidRecurring` has `accountType` but it's not in the unique constraint, causing the same merge issue.

## Migration

**New file:** `prisma/migrations/<timestamp>_add_account_type_to_bid/migration.sql`

```sql
ALTER TABLE "Bid" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'yellow';

ALTER TABLE "Bid" DROP CONSTRAINT "Bid_auctionId_userId_entityId_key";
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_auctionId_userId_entityId_accountType_key" 
  UNIQUE ("auctionId", "userId", "entityId", "accountType");

ALTER TABLE "BidRecurring" DROP CONSTRAINT "BidRecurring_auctionBaseId_userId_entityId_key";
ALTER TABLE "BidRecurring" ADD CONSTRAINT "BidRecurring_auctionBaseId_userId_entityId_accountType_key" 
  UNIQUE ("auctionBaseId", "userId", "entityId", "accountType");
```

All existing rows default to `'yellow'`. No data loss.

## Schema Changes

**File:** `prisma/schema.full.prisma`

- `Bid`: add `accountType String @default("yellow")`, change `@@unique` to `[auctionId, userId, entityId, accountType]`
- `BidRecurring`: change `@@unique` to `[auctionBaseId, userId, entityId, accountType]`

Then run `pnpm run db:generate`.

## Service Changes — `src/server/services/auction.service.ts`

### `createBid()` (~line 359)

1. Derive `accountType` from the `accountTypes` parameter:
   ```ts
   const accountType = accountTypes[0] ?? 'yellow';
   ```

2. Add `accountType` to the bid query `where` (~line 378) so it only finds the bid for this buzz type:
   ```ts
   bids: { where: { userId, entityId, accountType }, ... }
   ```

3. Add `accountType` to `bid.create` data (~line 521)

4. Update `BidRecurring` upsert `where` (~line 556) to use the new composite key:
   ```ts
   auctionBaseId_userId_entityId_accountType: { auctionBaseId, entityId, userId, accountType }
   ```

### `getMyBids()` (~line 249)

Add `accountType: true` to the `select` so the frontend can distinguish yellow vs green bids.

### `getMyRecurringBids()` (~line 336)

Add `accountType: true` to the `select`.

### No changes needed

- `prepareBids()` — aggregates by `entityId` across all bids. Yellow + green bids naturally sum together for rankings. `count` tiebreaker increments by 2 instead of 1 — negligible.
- `deleteBid()` — operates by `bidId` (primary key). User deletes yellow and green bids independently.
- `deleteBidsForModel()` / `deleteBidsForModelVersion()` — bulk operations on all bids for an entity, regardless of type.
- All refund logic — uses `transactionIds`, buzz service routes refunds to the correct account automatically.

## Job Changes — `src/server/jobs/handle-auctions.ts`

### `createRecurringBids()` (~line 547)

1. Existing bid check (~line 605): add `accountType: recurringBid.accountType` to the `where` so a green recurring bid isn't skipped because a yellow bid already exists.

2. `bid.create` (~line 679): add `accountType: recurringBid.accountType` to the data.

## Router Changes

None. `accountTypes` is already server-derived from `getAllowedAccountTypes(ctx.features)`.

## Frontend Changes

Minimal — `getMyBids` and `getMyRecurringBids` now return `accountType`. Users with bids from both domains will see two entries in "My Bids" (one yellow, one green). Optionally add a `CurrencyIcon` with the buzz type to distinguish them visually.

## Verification

1. Run `pnpm run db:migrate:empty` to create the migration file, paste the SQL
2. Run `pnpm run db:generate` to regenerate Prisma client
3. `pnpm run typecheck` — verify no type errors from renamed unique constraint
4. Test: place a bid on .com (yellow), then the same entity from .red (green) — should create two separate bid rows
5. Test: recurring bid from .com and .red on the same entity — should create two separate recurring bid rows
6. Test: delete the yellow bid — green bid should remain unaffected
7. Test: auction rankings should show combined total from both bids
