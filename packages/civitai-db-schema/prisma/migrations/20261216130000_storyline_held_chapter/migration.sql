-- Copies of a storyline chapter, and of the rows its delete cascades to, written by the same
-- DELETE when an owner or author removes a chapter that must be kept for records. Source columns,
-- plus the storyline owner and chapter author for the purge, and when the copy was made.
CREATE TABLE IF NOT EXISTS "HeldStorylineChapter" (
  "id" INTEGER PRIMARY KEY,
  "storylineId" INTEGER NOT NULL,
  "postId" INTEGER,
  "userId" INTEGER NOT NULL,
  "depth" INTEGER NOT NULL,
  "placementId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "removedAt" TIMESTAMP(3),
  "ownerId" INTEGER NOT NULL,
  "authorId" INTEGER NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[]
);

CREATE TABLE IF NOT EXISTS "HeldStorylineChapterEdge" (
  "storylineId" INTEGER NOT NULL,
  "chapterId" INTEGER NOT NULL,
  "parentChapterId" INTEGER NOT NULL,
  "canon" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "ownerId" INTEGER NOT NULL,
  "authorId" INTEGER NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[],
  PRIMARY KEY ("chapterId", "parentChapterId")
);

-- The source key is (userId, parentChapterId), which a reader reuses once a held chapter's choice
-- is gone; chapterId keeps a later copy of the same fork point distinct.
CREATE TABLE IF NOT EXISTS "HeldStorylineBranchChoice" (
  "userId" INTEGER NOT NULL,
  "parentChapterId" INTEGER NOT NULL,
  "chapterId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "ownerId" INTEGER NOT NULL,
  "authorId" INTEGER NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[],
  PRIMARY KEY ("userId", "parentChapterId", "chapterId")
);

CREATE TABLE IF NOT EXISTS "HeldStorylineCreateClick" (
  "userId" INTEGER NOT NULL,
  "parentChapterId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "ownerId" INTEGER NOT NULL,
  "authorId" INTEGER NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdReasons" TEXT[],
  PRIMARY KEY ("userId", "parentChapterId")
);

CREATE INDEX IF NOT EXISTS "HeldStorylineChapter_ownerId_idx" ON "HeldStorylineChapter" ("ownerId");
CREATE INDEX IF NOT EXISTS "HeldStorylineChapter_authorId_idx" ON "HeldStorylineChapter" ("authorId");
CREATE INDEX IF NOT EXISTS "HeldStorylineChapterEdge_ownerId_idx" ON "HeldStorylineChapterEdge" ("ownerId");
CREATE INDEX IF NOT EXISTS "HeldStorylineChapterEdge_authorId_idx" ON "HeldStorylineChapterEdge" ("authorId");
CREATE INDEX IF NOT EXISTS "HeldStorylineBranchChoice_ownerId_idx" ON "HeldStorylineBranchChoice" ("ownerId");
CREATE INDEX IF NOT EXISTS "HeldStorylineBranchChoice_authorId_idx" ON "HeldStorylineBranchChoice" ("authorId");
CREATE INDEX IF NOT EXISTS "HeldStorylineCreateClick_ownerId_idx" ON "HeldStorylineCreateClick" ("ownerId");
CREATE INDEX IF NOT EXISTS "HeldStorylineCreateClick_authorId_idx" ON "HeldStorylineCreateClick" ("authorId");

-- A chapter's delete, and its copy, find the reader choices into it by this.
CREATE INDEX IF NOT EXISTS "StorylineBranchChoice_chapterId_idx" ON "StorylineBranchChoice" ("chapterId");
