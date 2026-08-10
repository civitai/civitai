-- Validates the constraint added NOT VALID by 20260809040000.
--
-- **Its own migration so it cannot share a transaction with the ALTER that
-- added it.** Postgres holds every lock until the transaction ends, so an
-- `ADD CONSTRAINT ... NOT VALID` and a `VALIDATE CONSTRAINT` in one transaction
-- keep the ACCESS EXCLUSIVE from the first across the scan of the second — the
-- exact blocking the split exists to avoid, plus an extra catalogue update.
-- Run separately (or under autocommit), never inside `psql --single-transaction`
-- together with the previous file.
--
-- The guard is the point of the DO block. `VALIDATE CONSTRAINT` on an
-- already-valid constraint SUCCEEDS as a no-op, so running this file alone
-- against a database that never got 20260809040000 would find the ORIGINAL
-- constraint, validate nothing, return success, and leave 'cosmeticTakedown'
-- still forbidden — with every reason to believe the migration landed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Placement_removedBy_check'
      AND pg_get_constraintdef(oid) LIKE '%cosmeticTakedown%'
  ) THEN
    RAISE EXCEPTION
      'Placement_removedBy_check does not allow cosmeticTakedown — apply 20260809040000 first';
  END IF;

  -- The widened constraint accepts everything the old one did, so this cannot
  -- fail on existing rows.
  ALTER TABLE "Placement" VALIDATE CONSTRAINT "Placement_removedBy_check";
END
$$;
