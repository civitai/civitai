\set ON_ERROR_STOP on
-- HAND-APPLIED with psql on a direct primary connection. Validates the key 20271122130000 added NOT
-- VALID, in its own transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE on "ImageConnection" (reads and
-- writes go on) and scans it. A row orphaned between the two files fails it: re-run file 1's DELETE, then
-- this. Never dry-run it inside BEGIN ... ROLLBACK with file 1; on a clone that has file 1, run the
-- ALTER below between BEGIN; and ROLLBACK;.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30min';
DO $validate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ImageConnection_imageId_fkey' AND conrelid = '"ImageConnection"'::regclass
  ) THEN
    RAISE EXCEPTION 'ImageConnection_imageId_fkey is missing: apply 20271122130000 first';
  END IF;
  ALTER TABLE "ImageConnection" VALIDATE CONSTRAINT "ImageConnection_imageId_fkey";
END
$validate$;
COMMIT;
