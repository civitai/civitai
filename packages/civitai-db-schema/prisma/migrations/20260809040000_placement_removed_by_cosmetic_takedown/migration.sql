-- A cosmetic takedown is a third way a placement can be removed, and it refunds
-- like an owner's removal rather than a moderator's: the placer holds revoked
-- artwork instead of having authored it. The reason is recorded rather than
-- folded into 'owner', because the money is the same and the record is not, and
-- the record is what a reconcile reads to explain why someone was paid.
--
-- The column is TEXT; this constraint is the only thing that has to change.
--
-- Two statements on purpose. A plain ADD CONSTRAINT ... CHECK takes ACCESS
-- EXCLUSIVE and scans every row with writes blocked; NOT VALID takes the lock
-- only long enough to record the constraint, and VALIDATE then scans under
-- SHARE UPDATE EXCLUSIVE, which writers do not queue behind. Run them
-- separately if "Placement" is large enough for the scan to matter.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_removedBy_check') THEN
    ALTER TABLE "Placement" DROP CONSTRAINT "Placement_removedBy_check";
  END IF;

  ALTER TABLE "Placement"
    ADD CONSTRAINT "Placement_removedBy_check"
    CHECK (
      ("status" <> 'removed' AND "removedBy" IS NULL) OR
      ("status" =  'removed' AND "removedBy" IN ('owner', 'moderator', 'cosmeticTakedown'))
    ) NOT VALID;
END
$$;

-- The widened constraint accepts everything the old one did, so this cannot
-- fail on existing rows; it is here so the constraint stops being NOT VALID and
-- the planner can rely on it.
ALTER TABLE "Placement" VALIDATE CONSTRAINT "Placement_removedBy_check";
