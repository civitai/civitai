-- Removes the legal holds, part 2 of 2: queues the blocked images the holds kept for purge, then drops
-- the evidence-hold view, tables and functions.
--
-- Hand-applied, per environment, after part 1 (20271127130000_drop_legal_hold_triggers) and only once
-- the release captain clears its release condition: an external reader still reads these relations.
-- Every statement is re-runnable.
SET lock_timeout = '3s';

-- A kept image a hold trigger blocked has no other record once its table goes: queue each blocked one
-- for the blocked-image purge, as any block does.
DO $$
BEGIN
  IF to_regclass('public."EvidenceHoldImage"') IS NOT NULL THEN
    PERFORM create_job_queue_record(i.id, 'Image', 'BlockedImageDelete')
    FROM "EvidenceHoldImage" e
    JOIN "Image" i ON i.id = e."imageId"
    WHERE i.ingestion = 'Blocked' AND i."blockedFor" IS DISTINCT FROM 'AiNotVerified';
  END IF;
END $$;

-- The view, then the tables (their own triggers go with them).
DROP VIEW IF EXISTS "EvidenceHeldUser";
DROP TABLE IF EXISTS "EvidenceHoldImage", "EvidenceHoldPost", "EvidenceHold", "HeldResourceReview";

DROP FUNCTION IF EXISTS evidence_hold_from_csam_report();
DROP FUNCTION IF EXISTS evidence_hold_keep_image();
DROP FUNCTION IF EXISTS evidence_hold_keep_post();
DROP FUNCTION IF EXISTS evidence_hold_keep_owner();
DROP FUNCTION IF EXISTS evidence_hold_guard_end();
DROP FUNCTION IF EXISTS evidence_hold_guard_kept();
DROP FUNCTION IF EXISTS evidence_hold_refuse_truncate();
DROP FUNCTION IF EXISTS evidence_hold_purge_on_release();
DROP FUNCTION IF EXISTS evidence_hold_purge_unheld(INTEGER);
DROP FUNCTION IF EXISTS evidence_hold_capture_held(INTEGER, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS evidence_hold_capture_state_held(INTEGER, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS evidence_hold_owner_held_memo(INTEGER);
DROP FUNCTION IF EXISTS evidence_hold_owner_held(INTEGER);
