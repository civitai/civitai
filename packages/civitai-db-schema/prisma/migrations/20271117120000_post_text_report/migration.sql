-- Reporting a single storyline text, and a moderator's refusal of one.
--
-- Additive only: a new table and two defaulted columns, no enum value. Apply it BEFORE the code that
-- reads them deploys (the post report queue and the text scan name both). Every step is re-runnable.
SET lock_timeout = '3s';

-- A moderator's refusal, kept apart from the scan's so a later clean verdict does not lift it.
ALTER TABLE "PostText" ADD COLUMN IF NOT EXISTS "refusedByModerator" BOOLEAN NOT NULL DEFAULT false;
-- The scan's own refusal while a moderator's covers it, so a restore puts the scan's verdict back.
ALTER TABLE "PostText" ADD COLUMN IF NOT EXISTS "refusedByScan" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "PostTextReport" (
    "reportId" INTEGER NOT NULL,
    "postTextId" INTEGER,
    "postId" INTEGER NOT NULL,

    CONSTRAINT "PostTextReport_pkey" PRIMARY KEY ("reportId")
);

CREATE INDEX IF NOT EXISTS "PostTextReport_postTextId_idx" ON "PostTextReport" USING HASH ("postTextId");
CREATE INDEX IF NOT EXISTS "PostTextReport_postId_idx" ON "PostTextReport" USING HASH ("postId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostTextReport_reportId_fkey') THEN
    ALTER TABLE "PostTextReport" ADD CONSTRAINT "PostTextReport_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostTextReport_postTextId_fkey') THEN
    ALTER TABLE "PostTextReport" ADD CONSTRAINT "PostTextReport_postTextId_fkey"
      FOREIGN KEY ("postTextId") REFERENCES "PostText"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostTextReport_postId_fkey') THEN
    ALTER TABLE "PostTextReport" ADD CONSTRAINT "PostTextReport_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
