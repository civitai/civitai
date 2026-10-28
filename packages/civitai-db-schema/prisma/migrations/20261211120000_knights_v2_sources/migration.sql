-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the main app and the Knights app: the enqueue path writes "prediction".
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "prediction" JSONB;

-- One open item per question and image. Hidden checks are exempt: they are served apart from the feed.
-- Non-concurrent: apply before the queue holds duplicate open rows, or the unique index fails to build.
-- Only 'Open' is indexed, so a later move to Resolved or Inquisitor can never collide with a newer open item.
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsQueueItem_open_question_image_key"
  ON "KnightsQueueItem" ("questionKey", "imageId")
  WHERE "status" = 'Open' AND NOT "isHiddenCheck";
