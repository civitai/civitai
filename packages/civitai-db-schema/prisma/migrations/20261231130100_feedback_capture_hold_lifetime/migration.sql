-- A feedback page capture (owner -2) that a delete kept stays recorded in "EvidenceHoldImage" exactly
-- as long as its own state keeps it, the state `captureImageStateHeldSql` in
-- src/server/services/legal-hold.service.ts reads.
--
-- evidence_hold_purge_unheld and evidence_hold_guard_kept are otherwise unchanged from
-- 20261019220000_evidence_hold, as applied;
-- src/server/jobs/__tests__/feedback-capture-trigger.behavior.test.ts keeps them so.
--
-- Apply AFTER 20261231120100_feedback_capture_owner_hold. Hand-applied, as one transaction
-- (psql -v ON_ERROR_STOP=1 --single-transaction -f migration.sql) so the refusal below stops the
-- whole file: run statement by statement, the functions below would still be replaced. Dry run: the
-- whole file inside BEGIN; ... ROLLBACK;.
--
-- Must not be applied after 20261227150000_evidence_hold_owner_held; 20261227150000 supersedes it.
-- Applied after it, this file would put back the marker-only owner check in both functions below.
-- The block below refuses in that case: carry this file's capture clauses into 20261227150000 instead.
DO $$
BEGIN
  IF to_regprocedure('evidence_hold_owner_held(integer)') IS NOT NULL THEN
    RAISE EXCEPTION '20261231130100_feedback_capture_hold_lifetime must not be applied after 20261227150000_evidence_hold_owner_held, which supersedes it: carry its capture clauses into 20261227150000 instead';
  END IF;
END $$;

-- The capture's own state, without the record a kept delete leaves (which would keep itself).
CREATE OR REPLACE FUNCTION evidence_hold_capture_state_held(
  iid INTEGER, review TEXT, blocked TEXT, is_minor BOOLEAN
) RETURNS boolean AS $$
  SELECT review IS NOT DISTINCT FROM 'csam'
    OR blocked IS NOT DISTINCT FROM 'CSAM'
    OR is_minor IS TRUE
    OR iid::text IN (
      SELECT listed.id FROM (
        SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
        FROM "CsamReport" lr
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
        ) le
      ) listed
      WHERE listed.id IS NOT NULL
    );
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION evidence_hold_capture_held(
  iid INTEGER, review TEXT, blocked TEXT, is_minor BOOLEAN
) RETURNS boolean AS $$
  SELECT evidence_hold_capture_state_held(iid, review, blocked, is_minor)
    OR EXISTS (SELECT 1 FROM "EvidenceHoldImage" ehi WHERE ehi."imageId" = iid);
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION evidence_hold_purge_unheld(target_user INTEGER DEFAULT NULL) RETURNS void AS $$
  DELETE FROM "EvidenceHoldPost" p
  WHERE (target_user IS NULL OR p."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = p."userId");
  DELETE FROM "EvidenceHoldImage" i
  WHERE (target_user IS NULL OR i."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = i."userId")
    -- Per row by primary key, and only for capture rows: never a scan of "Image".
    AND NOT CASE WHEN i."userId" = -2 THEN COALESCE((
      SELECT evidence_hold_capture_state_held(im."id", im."needsReview", im."blockedFor", im."minor")
      FROM "Image" im WHERE im."id" = i."imageId"
    ), false) ELSE false END;
$$ LANGUAGE sql SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION evidence_hold_guard_kept() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% % cannot change', TG_TABLE_NAME, OLD."userId";
  END IF;
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
    RAISE EXCEPTION '% row cannot be deleted while its owner is held', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'EvidenceHoldImage' AND OLD."userId" = -2 THEN
    IF EXISTS (
      SELECT 1 FROM "Image" im
      WHERE im."id" = OLD."imageId"
        AND evidence_hold_capture_state_held(im."id", im."needsReview", im."blockedFor", im."minor")
    ) THEN
      RAISE EXCEPTION '% row cannot be deleted while its image is held', TG_TABLE_NAME;
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
