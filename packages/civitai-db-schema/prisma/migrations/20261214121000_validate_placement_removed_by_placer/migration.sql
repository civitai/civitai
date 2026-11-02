-- Validates the constraint added NOT VALID by 20261214120000. Its own transaction: see
-- 20260809041000. Guarded, because validating the old constraint succeeds as a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Placement_removedBy_check'
      AND pg_get_constraintdef(oid) LIKE '%placer%'
  ) THEN
    RAISE EXCEPTION
      'Placement_removedBy_check does not allow placer — apply 20261214120000 first';
  END IF;

  ALTER TABLE "Placement" VALIDATE CONSTRAINT "Placement_removedBy_check";
END
$$;
