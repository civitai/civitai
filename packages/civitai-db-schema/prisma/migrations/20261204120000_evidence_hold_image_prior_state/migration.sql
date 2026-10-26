-- What a kept image was before the hold's delete trigger blocked it, so a release can be judged
-- against it. Recorded with the first keep only, like the rest of the row.
--
-- Apply after 20261019220000_evidence_hold. Rows kept before this runs have no prior values.

ALTER TABLE "EvidenceHoldImage"
  ADD COLUMN "priorIngestion" TEXT,
  ADD COLUMN "priorBlockedFor" TEXT,
  ADD COLUMN "priorNsfwLevel" INTEGER;

-- As in 20261019220000_evidence_hold, plus the prior values. An account-deletion grace block had
-- already blocked the row and kept its prior ingestion and block reason in metadata, which this
-- trigger removes, so those are recorded instead; its nsfwLevel was not kept, so the blocked level
-- is what is recorded for it.
CREATE OR REPLACE FUNCTION evidence_hold_keep_image() RETURNS trigger AS $$
DECLARE
  graced BOOLEAN := (OLD."metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
BEGIN
  IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN
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
