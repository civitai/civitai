-- ============================================================
-- AppAccessRequest."reviewSource" — who decided a request
-- ============================================================
-- One ADDITIVE nullable column with a CHECK, and a backfill of the rows already decided.
--
-- 'moderator' for a moderator's decision, 'system' for an approval `app-access-auto-approve`
-- made on submit. Kept apart from "reviewedById", which is ON DELETE SET NULL, so a deleted
-- moderator account no longer looks like an automatic approval.
--
-- Backfill: a row with a reviewer is a moderator's. An approved row with no reviewer whose
-- "reviewedAt" equals its "createdAt" is an automatic approval: submit sets both in one statement,
-- so both are that transaction's start time, while a moderator's decide is always a later
-- transaction. Anything else with no reviewer (a deleted moderator's decision) stays NULL, which
-- the queue reads as a moderator's.
--
-- ⚠️ MANUAL APPLY, per environment (psql / retool). Apply BEFORE deploying the code that writes
-- it: every decision and every automatic approval writes this column, and fails without it.
-- Dry run: BEGIN; <this file without its own BEGIN and COMMIT>; ROLLBACK;
--
-- Idempotent: a re-run is a no-op.

BEGIN;

-- ADD COLUMN and ADD CONSTRAINT take an ACCESS EXCLUSIVE lock, and the auth hub reads this table
-- on every session it builds: give up rather than queue behind a long transaction.
SET LOCAL lock_timeout = '3s';

ALTER TABLE "AppAccessRequest" ADD COLUMN IF NOT EXISTS "reviewSource" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppAccessRequest_reviewSource_check'
  ) THEN
    ALTER TABLE "AppAccessRequest" ADD CONSTRAINT "AppAccessRequest_reviewSource_check"
      CHECK ("reviewSource" IN ('moderator', 'system'));
  END IF;
END $$;

UPDATE "AppAccessRequest" SET "reviewSource" = 'moderator'
WHERE "reviewSource" IS NULL AND "reviewedById" IS NOT NULL;

UPDATE "AppAccessRequest" SET "reviewSource" = 'system'
WHERE "reviewSource" IS NULL AND "reviewedById" IS NULL AND "status" = 'approved'
  AND "reviewedAt" = "createdAt";

COMMIT;
