-- Idempotent: applied by hand, possibly more than once.
--
-- A stored prize pool for the feed's "Prize Pool" sort, as challenges have: the seed plus the fee
-- of every entry that paid one. Payouts still derive from the entries themselves.
--
-- 🔴 APPLY BEFORE THE CODE DEPLOYS (the new build sorts on the column). Where crucibles are
-- already running, entries made by the previous build in between don't raise it: re-run the
-- backfill once the deploy lands. A backfill racing a new entry can leave that crucible one fee
-- low until the next run; it only affects the sort order.

ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "prizePool" INTEGER NOT NULL DEFAULT 0;

UPDATE "Crucible" c
SET "prizePool" = c."seededPrizePool" + c."entryFee" * (
  SELECT count(*) FROM "CrucibleEntry" e
  WHERE e."crucibleId" = c.id AND e."buzzTransactionId" IS NOT NULL
)
WHERE c."prizePool" IS DISTINCT FROM c."seededPrizePool" + c."entryFee" * (
  SELECT count(*) FROM "CrucibleEntry" e
  WHERE e."crucibleId" = c.id AND e."buzzTransactionId" IS NOT NULL
);
