-- A placer taking their own approved placement down is a fourth way a placement is removed: a
-- storyline contributor removing the chapter they added. No Buzz moves on it (the placement was
-- approved and settled), and the record says who chose it.
--
-- Added NOT VALID, as 20260809040000 did, so the lock is brief; the scan is in 20261214121000,
-- which must run in its own transaction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Placement_removedBy_check') THEN
    ALTER TABLE "Placement" DROP CONSTRAINT "Placement_removedBy_check";
  END IF;

  ALTER TABLE "Placement"
    ADD CONSTRAINT "Placement_removedBy_check"
    CHECK (
      ("status" <> 'removed' AND "removedBy" IS NULL) OR
      ("status" =  'removed' AND "removedBy" IN ('owner', 'moderator', 'cosmeticTakedown', 'placer'))
    ) NOT VALID;
END
$$;
