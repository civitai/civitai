-- Creator mystery packs: a box a creator builds from their own cosmetics, whose sales pay them.
--
-- 1. "ItemDefinition"."sellerId": the creator a box's sales pay (the creator side of
--    computeCreatorShopSplit; creator boxes have no reseller). NULL is a platform box, which pays no
--    one; every existing row stays NULL. Only a box may have one. ON DELETE RESTRICT: accounts are
--    soft-deleted ("User"."deletedAt"), so a hard delete of a seller is refused rather than leaving a
--    box whose sales pay no one.
-- 2. "BoxRevision": a creator's proposed next version of their box, waiting for review. At most one
--    pending revision per box.
--
-- Additive only: a new nullable column, a new table, no rows move. Nothing reads either until the
-- creator mystery pack code ships, so it can be applied before or after that deploy.
--
-- HOW TO APPLY: `psql -v ON_ERROR_STOP=1 -f migration.sql`, off-peak. Three short transactions, each
-- safe to run again. If one times out, psql ends the session (releasing its locks); run the whole
-- file again. In a client that keeps the session open after an error, ROLLBACK before retrying: an
-- aborted transaction keeps its locks until it is rolled back.
--
-- Before running, check that no autovacuum (pg_stat_progress_vacuum) or long-running write
-- (pg_stat_activity) is on "User" or "ItemDefinition". A lock timeout (SQLSTATE 55P03) means another
-- session held a lock past 1 s; the step that timed out changed nothing, so run the file again.
--
-- Locks:
--   - "ItemDefinition" is read FOR SHARE by every box open, and opens give up after 2 s. Step 1 takes
--     ACCESS EXCLUSIVE on it, which blocks those reads, for a catalog change plus a CHECK scan of a
--     table of a few hundred rows. lock_timeout is 1 s, below what opens tolerate.
--   - The foreign key also locks "User" (SHARE ROW EXCLUSIVE, which blocks User writes while held).
--     Step 2 takes the "User" lock FIRST, so it never waits on "User" while holding "ItemDefinition",
--     and then holds "ItemDefinition" only in SHARE ROW EXCLUSIVE, which does not block opens' reads.

-- Step 1: the column and the box-only CHECK, no foreign key yet.
BEGIN;
SET LOCAL lock_timeout = '1s';

ALTER TABLE "ItemDefinition"
  ADD COLUMN IF NOT EXISTS "sellerId" INTEGER,
  DROP CONSTRAINT IF EXISTS "ItemDefinition_sellerId_box_check",
  ADD CONSTRAINT "ItemDefinition_sellerId_box_check" CHECK ("sellerId" IS NULL OR "type" = 'box');

COMMIT;

-- Step 2: the foreign key. The column is all NULL, so checking existing rows costs nothing. Added NOT
-- VALID inside a catalog check, then validated on every run, so a re-run also validates a constraint
-- that exists but was left NOT VALID. The catalog check stands in for DROP CONSTRAINT IF EXISTS, which
-- takes ACCESS EXCLUSIVE even when there is nothing to drop.
BEGIN;
SET LOCAL lock_timeout = '1s';

LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ItemDefinition_sellerId_fkey' AND conrelid = '"ItemDefinition"'::regclass
  ) THEN
    ALTER TABLE "ItemDefinition"
      ADD CONSTRAINT "ItemDefinition_sellerId_fkey"
      FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;
ALTER TABLE "ItemDefinition" VALIDATE CONSTRAINT "ItemDefinition_sellerId_fkey";

COMMIT;

-- Step 3: the index and the revisions table. Nothing reads or writes either yet.
BEGIN;
SET LOCAL lock_timeout = '1s';

CREATE INDEX IF NOT EXISTS "ItemDefinition_sellerId_idx"
  ON "ItemDefinition" ("sellerId")
  WHERE "sellerId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "BoxRevision" (
  "id"              SERIAL PRIMARY KEY,
  "boxDefinitionId" INTEGER NOT NULL REFERENCES "ItemDefinition"("id") ON DELETE CASCADE,
  "baseVersion"     INTEGER NOT NULL,
  "proposal"        JSONB NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending'
                    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn', 'stale')),
  "appliedVersion"  INTEGER,
  "submittedById"   INTEGER NOT NULL,
  "reviewedById"    INTEGER,
  "reviewedAt"      TIMESTAMP(3),
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "BoxRevision_one_pending_key"
  ON "BoxRevision" ("boxDefinitionId")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "BoxRevision_boxDefinitionId_createdAt_idx"
  ON "BoxRevision" ("boxDefinitionId", "createdAt");

COMMIT;
