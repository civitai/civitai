\set ON_ERROR_STOP on
-- HAND-APPLIED with psql on a direct primary connection (not the transaction pooler). Validates the
-- constraint added NOT VALID by 20261119180000, off-peak.
--
-- Its own migration so it cannot share a transaction with the ALTER that added it: VALIDATE takes
-- SHARE UPDATE EXCLUSIVE and scans "User" without blocking reads or writes, but inside the same
-- transaction it would run under the earlier ACCESS EXCLUSIVE. Never run it with
-- `psql --single-transaction` together with the previous file.
--
-- lock_timeout: SHARE UPDATE EXCLUSIVE waits behind autovacuum and other DDL on "User"; on a timeout
-- nothing changes, re-run. statement_timeout: set explicitly so a role default cannot stop the scan.
-- VALIDATE on a missing constraint errors, but on one already valid it succeeds as a no-op, so the
-- guard checks the constraint is the one 20261119180000 adds. This file commits: dry-run it with the
-- statements in the PR body, never by wrapping the file in BEGIN ... ROLLBACK.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30min';
DO $validate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'User_image_no_upload_key'
      AND conrelid = '"User"'::regclass
  ) THEN
    RAISE EXCEPTION 'User_image_no_upload_key is missing: apply 20261119180000 first';
  END IF;

  ALTER TABLE "User" VALIDATE CONSTRAINT "User_image_no_upload_key";
END
$validate$;
COMMIT;
