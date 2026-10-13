-- Image appeal outcomes, kept as labelled examples for evaluating the content classifiers.
--
-- A trigger on "Appeal" writes one row when an image appeal is decided. It snapshots the image at
-- decision time because a rejected image is purged a few days later, taking its url, pHash and level
-- with it. A trigger rather than app code because appeals are decided by several writers (both apps'
-- resolve paths, accept, bulk actions, the minor-flag queue), and a record one of them can skip is not
-- a record. The nightly `appeal-decision-records` job fills `removalLabel` and `restoredLevel`, which
-- are not known at decision time, and deletes rows the exclusion rules below cover.
--
-- Excluded from the start: an image under a CSAM flag or in any CSAM report, and an image whose owner
-- is named in one. The trigger writes nothing for those; the nightly job deletes any row that becomes
-- excluded later.
--
-- Apply order: any time; the trigger is inert until an image appeal is decided.
--
-- 🔴 CREATE OR REPLACE TRIGGER takes a SHARE ROW EXCLUSIVE lock on "Appeal" (blocks writes, not
-- reads). Do not add a DROP TRIGGER: that takes ACCESS EXCLUSIVE. Apply one statement at a time and
-- read each result; re-run on lock timeout.

CREATE TABLE IF NOT EXISTS "AppealDecisionRecord" (
  "id"                       BIGSERIAL PRIMARY KEY,
  "appealId"                 INTEGER NOT NULL,
  "imageId"                  INTEGER NOT NULL,
  "ownerId"                  INTEGER NOT NULL,
  "imageUrl"                 TEXT NOT NULL,
  "pHash"                    BIGINT,
  "promptHash"               TEXT,
  "nsfwLevel"                INTEGER NOT NULL,
  "nsfwLevelLocked"          BOOLEAN NOT NULL,
  "nsfwLevelReason"          TEXT,
  "aiNsfwLevel"              INTEGER,
  "blockedFor"               TEXT,
  "decision"                 TEXT NOT NULL,
  "resolvedReason"           TEXT,
  "decidedAt"                TIMESTAMPTZ(3) NOT NULL,
  "removalLabel"             TEXT,
  "restoredLevel"            INTEGER,
  "trainingLabelCorrectedAt" TIMESTAMPTZ(3),
  "createdAt"                TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppealDecisionRecord_appealId_key" ON "AppealDecisionRecord" ("appealId");
CREATE INDEX IF NOT EXISTS "AppealDecisionRecord_imageId_idx" ON "AppealDecisionRecord" ("imageId");
CREATE INDEX IF NOT EXISTS "AppealDecisionRecord_ownerId_idx" ON "AppealDecisionRecord" ("ownerId");

CREATE OR REPLACE FUNCTION appeal_decision_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "AppealDecisionRecord" (
    "appealId", "imageId", "ownerId", "imageUrl", "pHash", "promptHash", "nsfwLevel",
    "nsfwLevelLocked", "nsfwLevelReason", "aiNsfwLevel", "blockedFor", "decision", "resolvedReason",
    "decidedAt"
  )
  SELECT
    NEW.id, i.id, i."userId", i.url, i."pHash", md5(i.meta->>'prompt'), i."nsfwLevel",
    i."nsfwLevelLocked", i.metadata->>'nsfwLevelReason', i."aiNsfwLevel", i."blockedFor",
    NEW.status::text, NEW."resolvedReason", coalesce(NEW."resolvedAt", now())
  FROM "Image" i
  WHERE i.id = NEW."entityId"
    AND i."needsReview" IS DISTINCT FROM 'csam'
    AND NOT EXISTS (
      SELECT 1 FROM "CsamReport" c
      WHERE c."userId" = i."userId"
         OR c.images @> jsonb_build_array(jsonb_build_object('id', i.id))
    )
  ON CONFLICT ("appealId") DO NOTHING;
  RETURN NULL;
END;
$$;

SET lock_timeout = '5s';
CREATE OR REPLACE TRIGGER appeal_decision_record
AFTER UPDATE OF status ON "Appeal"
FOR EACH ROW
WHEN (
  OLD.status = 'Pending'
  AND NEW.status IN ('Approved', 'Rejected')
  AND NEW."entityType" = 'Image'
)
EXECUTE FUNCTION appeal_decision_record();
RESET lock_timeout;
