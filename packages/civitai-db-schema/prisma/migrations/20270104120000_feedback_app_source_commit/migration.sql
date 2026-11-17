-- ============================================================
-- Feedback → the developer's source commit on each app-block report
-- ============================================================
-- ADDITIVE ONLY. Two NULLable columns and one CHECK on "Feedback". No existing
-- column, constraint or row is changed.
--
-- "appBlockSha" (already stamped) is the release commit in the app's platform repo,
-- not a commit in the developer's own tree. These two columns copy the developer's own
-- `sourceCommit` / `sourceDirty` claim from the publish request that was live when
-- the report was written, so the report names a commit in the developer's tree.
-- Both are an UNVERIFIED client claim, and NULL means unknown, never "clean".
--
-- ⚠️ MANUAL APPLY, per environment (the dev database PR previews use, then
-- production). EITHER ORDER relative to the deploy: both columns are no-type in
-- `schema.full.prisma` and are written and read only by raw SQL in
-- src/server/services/blocks/app-feedback.service.ts, which degrades on a missing
-- column (reports are still created and listed; the source commit is just not
-- kept or shown). Reports written before the apply carry no source commit.
--
-- TWO PARTS. Part 1 is one transaction, run as written including the `BEGIN`:
-- `SET LOCAL lock_timeout` only takes effect inside a transaction block. It holds
-- ACCESS EXCLUSIVE on "Feedback" only briefly: `ADD COLUMN ... NULL` with no
-- default is metadata-only (Postgres 11+), and the CHECK is added NOT VALID, so it
-- does not scan the table. On `canceling statement due to lock timeout` nothing was
-- applied: re-run it. Part 2 validates the CHECK against existing rows under SHARE
-- UPDATE EXCLUSIVE, which does not block reads or writes; every existing row passes
-- because both columns are created NULL.
--
-- Idempotent: `IF NOT EXISTS` on the columns, a `pg_constraint` guard on the CHECK.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "appSourceCommit" TEXT    NULL;
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "appSourceDirty"  BOOLEAN NULL;

DO $$
BEGIN
  -- Same rule as "Feedback_app_columns_check", for the two new columns: NULL unless
  -- "area" = 'app-block'. A separate constraint so that one is left untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_app_source_columns_check') THEN
    ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_app_source_columns_check"
      CHECK ("area" = 'app-block' OR ("appSourceCommit" IS NULL AND "appSourceDirty" IS NULL))
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- Part 2 — after Part 1 has committed. Idempotent: validating a valid constraint is a no-op.
ALTER TABLE "Feedback" VALIDATE CONSTRAINT "Feedback_app_source_columns_check";

-- ------------------------------------------------------------
-- Verification (read-only). Expect columns = 2, and one constraint with convalidated = t.
-- ------------------------------------------------------------
-- SELECT count(*) AS columns
--   FROM information_schema.columns
--  WHERE table_schema = current_schema() AND table_name = 'Feedback'
--    AND column_name IN ('appSourceCommit', 'appSourceDirty');
-- SELECT conname, convalidated
--   FROM pg_constraint
--  WHERE conrelid = '"Feedback"'::regclass
--    AND conname = 'Feedback_app_source_columns_check';
