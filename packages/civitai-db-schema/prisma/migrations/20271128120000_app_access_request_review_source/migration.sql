-- ============================================================
-- AppAccessRequest."reviewSource" — who decided a request
-- ============================================================
-- One ADDITIVE nullable column with a CHECK, and a backfill of the rows a moderator decided.
--
-- 'moderator' for a moderator's decision, 'system' for an approval `app-access-auto-approve`
-- made on submit. Kept apart from "reviewedById", which is ON DELETE SET NULL, so a deleted
-- moderator account no longer looks like an automatic approval.
--
-- Rows decided before this column with no reviewer left are not backfilled: from the row alone
-- they cannot be told apart, and the queue reads a NULL source as a moderator's decision.
--
-- ⚠️ MANUAL APPLY, per environment (psql / retool). Apply BEFORE deploying the code that writes
-- it: every decision and every automatic approval writes this column, and fails without it.
--
-- Idempotent: a re-run is a no-op.

ALTER TABLE "AppAccessRequest" ADD COLUMN IF NOT EXISTS "reviewSource" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AppAccessRequest_reviewSource_check'
  ) THEN
    ALTER TABLE "AppAccessRequest" ADD CONSTRAINT "AppAccessRequest_reviewSource_check"
      CHECK ("reviewSource" IN ('moderator', 'system'));
  END IF;
END $$;

UPDATE "AppAccessRequest" SET "reviewSource" = 'moderator'
WHERE "reviewSource" IS NULL AND "reviewedById" IS NOT NULL;
