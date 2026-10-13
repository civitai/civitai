-- Copy state for a Rejected record's image in the appeal training bucket, set by the
-- `appeal-training-copy` job: NULL pending, then 'copied', 'skipped' or 'failed'. "removalNsfw" is the
-- image's rating on its removal event, filled with "removalLabel".
--
-- Apply order: before the release that ships the job. Adding nullable columns without a default is a
-- metadata-only change.

ALTER TABLE "AppealDecisionRecord"
  ADD COLUMN IF NOT EXISTS "removalNsfw" TEXT,
  ADD COLUMN IF NOT EXISTS "trainingCopyState" TEXT,
  ADD COLUMN IF NOT EXISTS "trainingObjectKey" TEXT;
