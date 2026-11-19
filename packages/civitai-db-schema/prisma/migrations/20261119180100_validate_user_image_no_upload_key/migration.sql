-- Validates the constraint added NOT VALID by 20261119180000.
--
-- Its own migration so it cannot share a transaction with the ALTER that added it: VALIDATE takes
-- SHARE UPDATE EXCLUSIVE and scans "User" without blocking reads or writes, but inside the same
-- transaction it would run under the earlier ACCESS EXCLUSIVE. Run separately, never inside
-- `psql --single-transaction` together with the previous file.
--
-- VALIDATE on a missing constraint errors, but on one that is already valid it succeeds as a no-op,
-- so the guard checks the constraint is the one 20261119180000 adds.
DO $$
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
$$;
