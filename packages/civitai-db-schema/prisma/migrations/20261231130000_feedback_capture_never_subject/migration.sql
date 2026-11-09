-- The feedback capture account (-2, FEEDBACK_CAPTURE_OWNER_ID) owns page captures for their
-- reporters. It is never the subject of a report, nor of an evidence hold.
--
-- Apply AFTER 20261231120000_feedback_capture_owner. Hand-applied, outside a transaction: each
-- constraint is added NOT VALID (no scan) and then validated without blocking writes. The first
-- statement refuses if any existing row would break them.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CsamReport"
    WHERE "userId" = -2 OR "details" ->> 'secondaryUserId' = '-2'
  ) OR EXISTS (SELECT 1 FROM "EvidenceHold" WHERE "userId" = -2) THEN
    RAISE EXCEPTION 'Rows already name user -2; resolve them before applying';
  END IF;
END $$;

ALTER TABLE "CsamReport" ADD CONSTRAINT "CsamReport_not_capture_owner_check" CHECK (
  "userId" IS DISTINCT FROM -2 AND "details" ->> 'secondaryUserId' IS DISTINCT FROM '-2'
) NOT VALID;
ALTER TABLE "CsamReport" VALIDATE CONSTRAINT "CsamReport_not_capture_owner_check";

ALTER TABLE "EvidenceHold" ADD CONSTRAINT "EvidenceHold_not_capture_owner_check" CHECK (
  "userId" <> -2
) NOT VALID;
ALTER TABLE "EvidenceHold" VALIDATE CONSTRAINT "EvidenceHold_not_capture_owner_check";

-- After applying: both constraints, convalidated true.
SELECT conname, convalidated FROM pg_constraint
WHERE conname IN ('CsamReport_not_capture_owner_check', 'EvidenceHold_not_capture_owner_check');
