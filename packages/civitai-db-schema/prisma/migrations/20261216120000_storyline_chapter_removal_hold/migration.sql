-- Owner or author removal of a storyline chapter during an open report is held for moderator
-- review: the removal proceeds as usual and this row records it for the report's context.
CREATE TABLE IF NOT EXISTS "StorylineChapterRemovalHold" (
  "id" SERIAL PRIMARY KEY,
  "storylineId" INTEGER NOT NULL,
  "chapterId" INTEGER NOT NULL,
  "postId" INTEGER,
  "chapterUserId" INTEGER NOT NULL,
  "depth" INTEGER NOT NULL,
  "placementId" INTEGER,
  "parentChapterIds" INTEGER[] NOT NULL DEFAULT '{}',
  "chapterCreatedAt" TIMESTAMP(3) NOT NULL,
  "removedById" INTEGER NOT NULL,
  "removedByRole" TEXT NOT NULL,
  "reportIds" INTEGER[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "StorylineChapterRemovalHold_postId_idx" ON "StorylineChapterRemovalHold" ("postId");
CREATE INDEX IF NOT EXISTS "StorylineChapterRemovalHold_storylineId_idx" ON "StorylineChapterRemovalHold" ("storylineId");
