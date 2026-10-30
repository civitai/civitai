-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app build that serves yes/no questions and BEFORE running the import script.
-- Yes/no questions are KnightsQueueItem rows whose question (one per axis, kind 'bool') is created by the import.

ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "prompt" TEXT;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "audience" TEXT;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "yesEffect" TEXT;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "noEffect" TEXT;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "meta" JSONB;
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "voteCount" INTEGER NOT NULL DEFAULT 0;

-- The producer's id for a question; null for rating items (nulls do not collide).
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQueueItem_externalId_key" ON "KnightsQueueItem" ("externalId");

-- One open rating item per question and image (index from 20261211120000_knights_v2_sources). A yes/no question is one of
-- several that share an axis and an image, so it is exempt (it is unique by externalId instead). Rebuilt rather than skipped
-- when it exists, because the predicate changed; non-concurrent, so apply it before the queue is busy. Apply the sources
-- migration first: applied after this one, its IF NOT EXISTS would bring the old predicate back.
DO $$
BEGIN
  IF to_regclass('"KnightsQueueItem_open_question_image_key"') IS NOT NULL THEN
    DROP INDEX "KnightsQueueItem_open_question_image_key";
    CREATE UNIQUE INDEX "KnightsQueueItem_open_question_image_key"
      ON "KnightsQueueItem" ("questionKey", "imageId")
      WHERE "status" = 'Open' AND NOT "isHiddenCheck" AND "audience" IS NULL;
  END IF;
END $$;

-- The player feed's pick: the next open question of an axis, those already under way first.
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_yesno_serve_idx"
  ON "KnightsQueueItem" ("questionKey", "voteCount" DESC, "priority", "id")
  WHERE "status" = 'Open' AND "audience" = 'players';

-- The sweep's pick: questions that have answers and are still open.
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_yesno_answered_idx"
  ON "KnightsQueueItem" ("id")
  WHERE "status" = 'Open' AND "audience" IS NOT NULL AND "voteCount" > 0;
