-- Copy state for a Rejected record's image in the appeal training bucket, set by the
-- `appeal-training-copy` job: NULL pending, then 'copied', 'skipped' or 'failed'. "removalNsfw" is the
-- image's rating on its removal event, filled with "removalLabel". "ownerHash" is a keyed hash of the
-- image owner, set with the copy. "AppealTrainingObjectDeletion" holds training-bucket keys whose
-- delete failed, for the nightly sweep to retry.
--
-- Apply before the release that ships the job: the nightly `appeal-decision-records` sweep reads these
-- columns whether or not the training bucket is configured.

ALTER TABLE "AppealDecisionRecord"
  ADD COLUMN IF NOT EXISTS "removalNsfw" TEXT,
  ADD COLUMN IF NOT EXISTS "trainingCopyState" TEXT,
  ADD COLUMN IF NOT EXISTS "trainingObjectKey" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerHash" TEXT;

CREATE TABLE IF NOT EXISTS "AppealTrainingObjectDeletion" (
  "key"       TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
