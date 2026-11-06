-- Storylines: a post draft written from the storyline flow is linked to its storyline (and, for a
-- continuation, its parent chapter) from its first upload, before it is a chapter.
--
-- MANUAL APPLY, per environment, BEFORE the deploy that reads it: `post.create` and
-- `storyline.getPendingForPost` query this table. Purely additive: one new table, nothing existing
-- is altered. Each foreign key briefly takes a SHARE ROW EXCLUSIVE lock on the table it references
-- ("Post", "Storyline", "StorylineChapter"), so apply statement by statement with a lock timeout and
-- retry one that times out. Re-runnable.
SET lock_timeout = '3s';

-- CreateTable
-- No foreign key on "userId", as on "StorylineChapter".
CREATE TABLE IF NOT EXISTS "StorylinePendingChapter" (
    "postId" INTEGER NOT NULL,
    "storylineId" INTEGER NOT NULL,
    "parentChapterId" INTEGER,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylinePendingChapter_pkey" PRIMARY KEY ("postId")
);

CREATE INDEX IF NOT EXISTS "StorylinePendingChapter_storylineId_idx" ON "StorylinePendingChapter"("storylineId");
CREATE INDEX IF NOT EXISTS "StorylinePendingChapter_parentChapterId_idx" ON "StorylinePendingChapter"("parentChapterId");
-- At most one chapter-1 draft per storyline. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX IF NOT EXISTS "StorylinePendingChapter_storylineId_root_key" ON "StorylinePendingChapter"("storylineId") WHERE "parentChapterId" IS NULL;

ALTER TABLE "StorylinePendingChapter" DROP CONSTRAINT IF EXISTS "StorylinePendingChapter_postId_fkey";
ALTER TABLE "StorylinePendingChapter" ADD CONSTRAINT "StorylinePendingChapter_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylinePendingChapter" DROP CONSTRAINT IF EXISTS "StorylinePendingChapter_storylineId_fkey";
ALTER TABLE "StorylinePendingChapter" ADD CONSTRAINT "StorylinePendingChapter_storylineId_fkey" FOREIGN KEY ("storylineId") REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Keyed with "storylineId", so the parent is a chapter of the same storyline. A NULL
-- "parentChapterId" (chapter 1) is not checked.
ALTER TABLE "StorylinePendingChapter" DROP CONSTRAINT IF EXISTS "StorylinePendingChapter_parentChapterId_storylineId_fkey";
ALTER TABLE "StorylinePendingChapter" ADD CONSTRAINT "StorylinePendingChapter_parentChapterId_storylineId_fkey" FOREIGN KEY ("parentChapterId", "storylineId") REFERENCES "StorylineChapter"("id", "storylineId") ON DELETE CASCADE ON UPDATE CASCADE;
