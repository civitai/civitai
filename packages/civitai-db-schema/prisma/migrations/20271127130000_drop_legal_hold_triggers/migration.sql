-- Removes the legal holds, part 1 of 2: the evidence-hold triggers, the held-image purge queueing,
-- and the hold checks in two functions that stay. Holds stop acting once this is applied.
--
-- Hand-applied, per environment, right AFTER the code that stops reading the hold objects is deployed.
-- The hold tables and view stay until part 2 (20271127130100_drop_legal_hold_tables), which waits on
-- its own release condition. Every statement is re-runnable.
SET lock_timeout = '3s';

-- 1. Triggers on tables that stay.
DROP TRIGGER IF EXISTS "CsamReport_evidence_hold" ON "CsamReport";
DROP TRIGGER IF EXISTS "Image_evidence_hold" ON "Image";
DROP TRIGGER IF EXISTS "Image_evidence_hold_owner" ON "Image";
DROP TRIGGER IF EXISTS "Post_evidence_hold" ON "Post";
DROP TRIGGER IF EXISTS "Post_evidence_hold_owner" ON "Post";
DROP TRIGGER IF EXISTS "Model_evidence_hold_owner" ON "Model";

-- A kept image the trigger blocked has no other record once its table goes: queue each blocked one
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

-- 2. A sent report under a year old cannot be deleted.
CREATE OR REPLACE FUNCTION csam_report_guard_sent() RETURNS trigger AS $$
DECLARE
  secondary_user INTEGER;
BEGIN
  IF (OLD."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$' THEN
    secondary_user := (OLD."details" ->> 'secondaryUserId')::int;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."reportSentAt" IS NOT NULL THEN
      IF OLD."reportSentAt" > now() - interval '1 year' THEN
        RAISE EXCEPTION 'CsamReport % was sent less than a year ago and cannot be deleted', OLD."id";
      END IF;
    END IF;
    INSERT INTO "CsamReportAudit" (
      "csamReportId", "op", "oldUserId", "oldSecondaryUserId", "oldReportId", "oldType",
      "oldImageCount", "oldDetailsFingerprint", "oldReportSentAt"
    )
    VALUES (
      OLD."id", 'delete', OLD."userId", secondary_user, OLD."reportId", OLD."type"::text,
      CASE WHEN jsonb_typeof(OLD."images") = 'array' THEN jsonb_array_length(OLD."images") END,
      csam_audit.details_fingerprint(OLD."details"), OLD."reportSentAt"
    );
    RETURN OLD;
  END IF;

  IF OLD."reportSentAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."reportedById" IS DISTINCT FROM OLD."reportedById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."reportSentAt" IS DISTINCT FROM OLD."reportSentAt"
    OR NEW."reportId" IS DISTINCT FROM OLD."reportId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."images" IS DISTINCT FROM OLD."images"
  THEN
    RAISE EXCEPTION 'CsamReport % was sent; only details, archivedAt and contentRemovedAt may change', OLD."id";
  END IF;

  -- A details value that is not an object holds nothing to keep, so an object may replace it.
  IF jsonb_typeof(NEW."details") IS DISTINCT FROM 'object'
    OR (jsonb_typeof(OLD."details") = 'object' AND NOT NEW."details" @> OLD."details")
  THEN
    IF NEW."details" IS DISTINCT FROM OLD."details" THEN
      RAISE EXCEPTION 'CsamReport % was sent; its details may only gain keys', OLD."id";
    END IF;
  END IF;

  INSERT INTO "CsamReportAudit" (
      "csamReportId", "op", "oldUserId", "oldSecondaryUserId", "oldReportId", "oldType",
      "oldImageCount", "oldDetailsFingerprint", "oldReportSentAt"
  )
  VALUES (
    OLD."id", 'update', OLD."userId", secondary_user, OLD."reportId", OLD."type"::text,
    CASE WHEN jsonb_typeof(OLD."images") = 'array' THEN jsonb_array_length(OLD."images") END,
    csam_audit.details_fingerprint(OLD."details"), OLD."reportSentAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Post text keeps only its CSAM text-scan hold.
CREATE OR REPLACE FUNCTION post_text_held(
  text_id INTEGER, csam_held BOOLEAN, post_id INTEGER, author_id INTEGER
)
RETURNS boolean AS $$
BEGIN
  -- `csamHeld` keeps the text from readers for good; as a delete hold it stands until a moderator
  -- confirms the hold AND a CSAM report captured the post's text after the hold was raised. An
  -- older report, or one on the author or a comment alone, never captured this text.
  IF csam_held AND (
    EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Pending'
    )
    OR NOT EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Confirmed'
    )
    OR NOT EXISTS (
      -- The post's text as a report captured it after the hold was raised, so with this text in it.
      SELECT 1
      FROM "TextScanHold" h
      JOIN "CsamReport" r ON jsonb_typeof(r.details -> 'contextText') = 'array'
      CROSS JOIN LATERAL jsonb_array_elements(r.details -> 'contextText') c
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Confirmed'
        AND c ->> 'source' = 'postDescription'
        AND c ->> 'postId' = post_id::text
        AND (c ->> 'capturedAt') ~ '^\d{4}-\d{2}-\d{2}T'
        -- setText refuses a held text from the hold's detection on, so a capture taken at or after
        -- the hold's createdAt includes the held text.
        AND (c ->> 'capturedAt')::timestamptz >= h."createdAt" AT TIME ZONE 'UTC'
    )
  ) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp;
