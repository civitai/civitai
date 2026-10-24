-- One row per entity an owner has put a price on — a licensing fee or a permanent paid-access
-- gate — spending one of the monthly allowance slots their membership tier grants (free 3,
-- bronze 10, silver 25, gold unlimited).
--
-- What does NOT spend a slot: timed early access.
--
-- One row per ENTITY, not per kind. The primary key is the entity, so a version already carrying
-- a fee costs nothing further to gate, and vice versa — a version is priced or it is not.
--
-- Keyed (entityType, entityId) like PaidAccess itself, so gating anything else paid access grows
-- to cover — it already carries ComicChapter — needs no schema change here.
--
-- This table answers ONE question: how many slots has this owner spent in the current calendar
-- month. It is deliberately NOT the eligibility record. Whether a creator may apply a price at
-- all (the 10k creator-score floor) is read from current state — does the version carry a fee,
-- does a PaidAccess row exist — because grandfathering attaches to a price that is still set.
-- That needs no history, which is why there is no backfill below.
--
-- The row is deleted when the last price comes off an entity nothing has transacted against, which
-- returns the slot.
--
-- There is deliberately no foreign key to the entity. The key is polymorphic so there is nothing
-- to point at, and the consequence is wanted: deleting a version does not refund its slot. Rows
-- that outlive their entity are inert, because the count is scoped to the current month — a stale
-- row stops mattering when the month turns. The only cascade is the owner: delete the user and
-- their slots go with them.
--
-- ⚠️ APPLY UNDER A SHORT lock_timeout. The inline owner FK takes SHARE ROW EXCLUSIVE on "User", which
-- conflicts with the ROW EXCLUSIVE every in-flight User write holds — behind a long transaction it
-- queues and blocks all User writes for the duration. `SET lock_timeout = '3s';` first and retry on
-- failure, or add the constraint separately as NOT VALID and VALIDATE it afterwards.
--
-- 🔴 ORDERING: apply this BEFORE deploying the code. Until the table exists, every first-time pricing
-- write throws on a missing relation — in both apps — rather than degrading, and the Creator Studio
-- models page 500s outright because its loader counts slots.
--
-- Idempotent: re-running is a no-op.

CREATE TABLE IF NOT EXISTS "PricingSlot" (
  "entityType" "PaidAccessEntityType" NOT NULL,
  "entityId"   INTEGER NOT NULL,
  "ownerId"    INTEGER NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PricingSlot_pkey" PRIMARY KEY ("entityType", "entityId"),
  CONSTRAINT "PricingSlot_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PricingSlot_ownerId_createdAt_idx"
  ON "PricingSlot" ("ownerId", "createdAt");

-- No backfill. Everyone starts the feature with an empty ledger, so gates applied before it ships
-- cost nobody their first month's allowance, and nothing existing is treated as already-spent.
