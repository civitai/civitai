-- Copy state for a Rejected record's image in the appeal training bucket, set by the
-- `appeal-training-copy` job: NULL pending, then 'copied', 'skipped' or 'failed'.
--
-- Apply order: before the release that ships the job. Adding nullable columns without a default is a
-- metadata-only change.

ALTER TABLE "AppealDecisionRecord"
  ADD COLUMN IF NOT EXISTS "trainingCopyState" TEXT,
  ADD COLUMN IF NOT EXISTS "trainingObjectKey" TEXT;
