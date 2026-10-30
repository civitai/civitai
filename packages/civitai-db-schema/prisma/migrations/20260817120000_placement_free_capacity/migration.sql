-- Free placement capacity: how many free placements a space accepts, and which
-- placements were made against that capacity rather than paid for.
--
-- APPLY BEFORE deploying the app that reads these. Both columns are additive and
-- carry defaults that reproduce today's behaviour exactly, so an old pod is
-- unaffected by their existence:
--
--   * "PlacementSpace"."freeSlots" is nullable with no default. NULL means the
--     owner has never chosen, which the app resolves to the surface default.
--     Old code never selects it and never writes it.
--   * "Placement"."free" defaults to false, so every row an old pod writes is a
--     paid placement, which is what it is.
--
-- NO BACKFILL, and none is needed: every placement that exists was paid for, and
-- false is the truth for all of them.
--
-- ⚠️ THE UNSAFE DIRECTION IS A ROLLBACK WITH FREE ROWS ALREADY MADE. Old code
-- does not know about `free`, so it settles such a row through the ordinary
-- money path. That path derives its payout from RECEIPTED HOLDS, of which a free
-- placement has none, so every leg computes to zero and is filtered out before it
-- is persisted — old code moves no money for a free row and cannot. What it does
-- lose is the reservation: old `resolvePlacementSpaceFor` does not count free
-- rows, so a space's free slots are unbounded while rolled back. The surfaces
-- that create free placements are behind the `sticker-placement` and
-- `remix-gallery` Flipt flags; turn those off before rolling back and the set
-- cannot grow.
--
-- ⚠️ NEVER DROP THESE COLUMNS on a rollback. `free` is the only record of which
-- placements were never paid for, and dropping it would make a later roll-forward
-- treat them as paid — reserving nothing, and offering a refund path to rows that
-- have nothing behind them. Old Prisma clients emit explicit column lists, so
-- leaving both in place costs nothing.

SET lock_timeout = '5s';
BEGIN;

-- 1. How many free placements this space accepts. Uncapped here on purpose: the
--    score/tier ceiling is computed at read, and a stored effective value would
--    go stale the moment a membership lapses. The CHECK only keeps the column
--    meaningful — a negative slot count is not a small number, it is nonsense
--    that would make `cap - reserved` arithmetic hand out capacity nobody set.
ALTER TABLE "PlacementSpace" ADD COLUMN IF NOT EXISTS "freeSlots" INTEGER;

ALTER TABLE "PlacementSpace" DROP CONSTRAINT IF EXISTS "PlacementSpace_freeSlots_check";
ALTER TABLE "PlacementSpace" ADD CONSTRAINT "PlacementSpace_freeSlots_check"
  CHECK ("freeSlots" IS NULL OR "freeSlots" >= 0);

-- 2. Whether this placement was made against free capacity.
--
--    NOT NULL with a default rather than nullable: there is no third state, and a
--    NULL here would have to be interpreted by every reader that decides whether
--    money moves.
ALTER TABLE "Placement" ADD COLUMN IF NOT EXISTS "free" BOOLEAN NOT NULL DEFAULT false;

-- 3. A free placement is worth zero, structurally.
--
--    The application never sizes a payout from `amount` — it reads receipted
--    holds, and a free placement has none — so this does not prevent a payout on
--    its own. What it prevents is a free row that LOOKS paid: `amount` is what
--    every report, every support answer and every future reader will quote, and a
--    free placement carrying a price is a row that says a creator earned
--    something they did not.
ALTER TABLE "Placement" DROP CONSTRAINT IF EXISTS "Placement_free_amount_check";
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_free_amount_check"
  CHECK (NOT "free" OR "amount" = 0);

-- 4. The index behind both entitlement checks — the daily allowance and the
--    never-twice rule — which run inside the claim transaction and so sit on the
--    latency path of every free placement.
--
--    PARTIAL (`WHERE "free"`), which Prisma cannot express: without the predicate
--    this indexes every placement ever made in order to answer questions asked
--    only about the free ones. Not CONCURRENTLY: the predicate matches zero rows
--    at apply time, so the build is instant, and a cancelled CONCURRENTLY build
--    leaves an INVALID index behind that then has to be found and dropped.
CREATE INDEX IF NOT EXISTS "Placement_placerId_free_createdAt_idx"
  ON "Placement" ("placerId", "free", "createdAt")
  WHERE "free";

COMMIT;

-- 5. VERIFY THE SCHEMA. Every statement above is idempotent and reports success
--    on a retry, so confirm each landed rather than reading a clean exit as
--    proof.
--
--      SELECT table_name, column_name, is_nullable, data_type, column_default
--      FROM information_schema.columns
--      WHERE (table_name, column_name)
--        IN (('PlacementSpace', 'freeSlots'), ('Placement', 'free'));
--
--    Expect two rows: a nullable `integer` with no default, and a NOT NULL
--    `boolean` defaulting to false.
--
--      SELECT conname, pg_get_constraintdef(oid), convalidated FROM pg_constraint
--      WHERE conname IN ('PlacementSpace_freeSlots_check', 'Placement_free_amount_check');
--
--    Both must report `convalidated = true`.
--
--      SELECT indexname, indexdef FROM pg_indexes
--      WHERE indexname = 'Placement_placerId_free_createdAt_idx';
--
--    The definition must contain `WHERE free`. An index built without the
--    predicate is not a smaller mistake — it is a full-table index that will be
--    quietly maintained on every placement forever.
--
-- 6. VERIFY THE BEHAVIOUR, after the deploy. Nothing above proves the app writes
--    these. Make one free placement, then:
--
--      SELECT id, free, amount, status, "expiresAt" FROM "Placement"
--      ORDER BY id DESC LIMIT 5;
--
--    The new row must read `free = true`, `amount = 0`, and carry a NON-NULL
--    `expiresAt`. The deadline is what releases the slot when the creator never
--    acts; a free row without one holds its slot forever and no sweep will ever
--    reach it.
--
--    Standing check afterwards — this should never return a row:
--
--      SELECT id, "createdAt" FROM "Placement"
--      WHERE free AND "expiresAt" IS NULL AND status = 'pending';
