-- Validates the app_blocks_status_check that 20261225120130 added NOT VALID: a scan under a
-- SHARE UPDATE EXCLUSIVE lock, so reads and writes carry on. Its own transaction, after
-- 20261225120130 has committed. Guarded: it refuses to validate the old list, and validating an
-- already valid constraint is a no-op.
--
-- MANUAL APPLY, per writable env, after 20261225120130 and before 20261225120200:
--   1. Dry run: this file inside BEGIN; ... ROLLBACK;
--   2. Apply.
--   3. After-read (read-only role):
--        SELECT pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conname = 'app_blocks_status_check';
--        -> CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text,
--           'deprecated'::text, 'remix'::text, 'remix_disabled'::text]))) | t
--
-- ROLLBACK: none needed; see 20261225120130.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_blocks_status_check'
      AND pg_get_constraintdef(oid) LIKE '%remix_disabled%'
  ) THEN
    RAISE EXCEPTION
      'app_blocks_status_check does not allow remix_disabled: apply 20261225120130 first';
  END IF;
  ALTER TABLE "app_blocks" VALIDATE CONSTRAINT "app_blocks_status_check";
END
$$;
