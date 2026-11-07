-- Adds 'remix' and 'remix_disabled' to app_blocks_status_check, for the system remix apps rows
-- that 20261225120200_remix_apps_as_rows inserts. Those statuses are what keep the rows out of
-- every App Blocks read that serves third-party apps, which all filter on 'approved'.
--
-- Added NOT VALID, so the swap takes only a brief lock and no scan; the scan is in
-- 20261225120140, which must run as its own transaction. Until then, new writes are checked
-- against the new list and existing rows are not rechecked. Guarded: a re-run once the
-- constraint allows 'remix_disabled' changes nothing.
--
-- MANUAL APPLY, per writable env, BEFORE 20261225120140 and 20261225120200:
--   0. Before-read (read-only role):
--        SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'app_blocks_status_check';
--        -> CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'deprecated'::text])))
--   1. Dry run: this file inside BEGIN; ... ROLLBACK;
--   2. Apply.
--   3. After-read (read-only role):
--        SELECT pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conname = 'app_blocks_status_check';
--        -> CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text,
--           'deprecated'::text, 'remix'::text, 'remix_disabled'::text]))) NOT VALID | f
--
-- ROLLBACK: first remove the remix rows (20261225120200 and mod writes add them), or the
-- VALIDATE below fails:
--   DELETE FROM app_blocks WHERE status IN ('remix', 'remix_disabled');
--   ALTER TABLE "app_blocks" DROP CONSTRAINT "app_blocks_status_check";
--   ALTER TABLE "app_blocks" ADD CONSTRAINT "app_blocks_status_check"
--     CHECK ("status" IN ('pending', 'approved', 'suspended', 'deprecated')) NOT VALID;
--   ALTER TABLE "app_blocks" VALIDATE CONSTRAINT "app_blocks_status_check";
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_blocks_status_check'
      AND pg_get_constraintdef(oid) LIKE '%remix_disabled%'
  ) THEN
    RETURN;
  END IF;
  ALTER TABLE "app_blocks" DROP CONSTRAINT IF EXISTS "app_blocks_status_check";
  ALTER TABLE "app_blocks"
    ADD CONSTRAINT "app_blocks_status_check"
    CHECK ("status" IN ('pending', 'approved', 'suspended', 'deprecated', 'remix', 'remix_disabled'))
    NOT VALID;
END
$$;
