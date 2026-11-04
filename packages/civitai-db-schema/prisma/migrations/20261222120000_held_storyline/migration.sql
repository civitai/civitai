-- A storyline's delete is always a hard delete. When something must be kept for records (an open
-- report on it, a held owner, chapter author or commenter, or a moderator's tombstone), the DELETE
-- statement itself first copies the storyline into "HeldStoryline" and every chapter into the
-- "HeldStorylineChapter*" tables. Only moderator tools and the purge read these copies.
--
-- Its reports outlive it: "StorylineReport" keeps each row with "storylineId" set NULL, plus the
-- held copy's id and the title, so the report stays listed and resolvable in the moderator queue.
--
-- MANUAL APPLY, per environment, BEFORE the deploy that writes "HeldStoryline". Safe for the
-- running code: it never names the new table or columns, and the moderator queue already shows a
-- report whose "storylineId" is NULL as "This storyline no longer exists". Re-runnable.
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "HeldStoryline" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3) NOT NULL,
  "deletedById" INTEGER NOT NULL,
  -- The reports open on it when it was deleted.
  "reportIds" INTEGER[] NOT NULL DEFAULT '{}',
  -- Every author of a comment in its threads when it was deleted: the purge keeps the copy while
  -- any of them is held.
  "commenterIds" INTEGER[] NOT NULL DEFAULT '{}',
  -- Its chapter-1 drafts, which the delete unlinks (the posts stay drafts), and their authors, who
  -- keep the copy while held as the commenters do.
  "pendingPostIds" INTEGER[] NOT NULL DEFAULT '{}',
  "pendingAuthorIds" INTEGER[] NOT NULL DEFAULT '{}',
  -- Its pictures: the images stay, but their link to it goes with it.
  "coverImageId" INTEGER,
  "heroImageId" INTEGER,
  "sparkImageId" INTEGER,
  "coverUploadImageIds" INTEGER[] NOT NULL DEFAULT '{}',
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Why it was kept: open-report, owner, chapter-author, commenter, pending-author, tombstone.
  "holdReasons" TEXT[]
);

CREATE INDEX IF NOT EXISTS "HeldStoryline_userId_idx" ON "HeldStoryline" ("userId");
-- The purge finds a held storyline's chapter copies by it.
CREATE INDEX IF NOT EXISTS "HeldStorylineChapter_storylineId_idx" ON "HeldStorylineChapter" ("storylineId");

-- The report link outlives the storyline. "reportId" is already unique, so it becomes the key.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StorylineReport_pkey' AND cardinality(conkey) = 2
  ) THEN
    ALTER TABLE "StorylineReport" DROP CONSTRAINT "StorylineReport_pkey";
    ALTER TABLE "StorylineReport"
      ADD CONSTRAINT "StorylineReport_pkey" PRIMARY KEY USING INDEX "StorylineReport_reportId_key";
  END IF;
END $$;
ALTER TABLE "StorylineReport" ALTER COLUMN "storylineId" DROP NOT NULL;
ALTER TABLE "StorylineReport" ADD COLUMN IF NOT EXISTS "heldStorylineId" INTEGER;
ALTER TABLE "StorylineReport" ADD COLUMN IF NOT EXISTS "storylineTitle" TEXT;

-- The swap in one transaction (a DO block), so no delete runs while the column has no foreign key;
-- skipped once the key already sets NULL.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StorylineReport_storylineId_fkey' AND confdeltype = 'n'
  ) THEN
    ALTER TABLE "StorylineReport" DROP CONSTRAINT IF EXISTS "StorylineReport_storylineId_fkey";
    ALTER TABLE "StorylineReport"
      ADD CONSTRAINT "StorylineReport_storylineId_fkey"
      FOREIGN KEY ("storylineId") REFERENCES "Storyline" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;
ALTER TABLE "StorylineReport" VALIDATE CONSTRAINT "StorylineReport_storylineId_fkey";
