-- The image delete trigger keeps a feedback page capture (owner -2, FEEDBACK_CAPTURE_OWNER_ID) that
-- `captureImageHeldSql` in src/server/services/legal-hold.service.ts keeps, so a direct delete cannot
-- remove it. evidence_hold_keep_image is otherwise unchanged from 20261204120000_evidence_hold_image_prior_state.
-- feedback-capture-trigger.behavior.test.ts keeps the two identical.
--
-- Apply AFTER 20261231120000_feedback_capture_owner. Hand-applied. Dry run: the whole file inside
-- BEGIN; ... ROLLBACK;.

CREATE OR REPLACE FUNCTION evidence_hold_capture_held(
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
    )
    OR EXISTS (SELECT 1 FROM "EvidenceHoldImage" ehi WHERE ehi."imageId" = iid);
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION evidence_hold_keep_image() RETURNS trigger AS $$
DECLARE
  graced BOOLEAN := (OLD."metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
BEGIN
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId")
    OR (OLD."userId" = -2
        AND evidence_hold_capture_held(OLD."id", OLD."needsReview", OLD."blockedFor", OLD."minor")) THEN
    IF pg_trigger_depth() > 1 THEN
      RAISE EXCEPTION 'Image % cannot be deleted', OLD."id";
    END IF;
    -- The first record stands: a later delete finds the image already out of its post.
    INSERT INTO "EvidenceHoldImage" (
      "imageId", "userId", "postId", "priorIngestion", "priorBlockedFor", "priorNsfwLevel"
    )
    VALUES (
      OLD."id",
      OLD."userId",
      OLD."postId",
      CASE WHEN graced THEN OLD."metadata" ->> 'accountDeletionPriorIngestion' ELSE OLD."ingestion"::text END,
      CASE WHEN graced THEN OLD."metadata" ->> 'accountDeletionPriorBlockedFor' ELSE OLD."blockedFor" END,
      OLD."nsfwLevel"
    )
    ON CONFLICT ("imageId") DO NOTHING;
    UPDATE "Image"
    SET "ingestion" = 'Blocked', "nsfwLevel" = 32, "blockedFor" = 'moderated', "updatedAt" = now()
    WHERE "id" = OLD."id" AND NOT (
      "ingestion" = 'Blocked' AND COALESCE("blockedFor", '') IN ('moderated', 'tos', 'CSAM')
    );
    UPDATE "Image" SET "postId" = NULL, "updatedAt" = now()
    WHERE "id" = OLD."id" AND "postId" IS NOT NULL;
    -- Kept counts as moderated, so the account-deletion markers go even on a row already blocked:
    -- restoring the account would otherwise put the image back (account-deletion-image-markers.ts).
    UPDATE "Image"
    SET "metadata" = "metadata" - 'accountDeletionPriorIngestion' - 'accountDeletionPriorBlockedFor'
    WHERE "id" = OLD."id" AND ("metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
