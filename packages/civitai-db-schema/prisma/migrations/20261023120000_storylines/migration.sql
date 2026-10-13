-- Storylines: branching stories where every chapter is a post.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. A human applies this per
-- environment (dev, preview, staging, prod) BEFORE the code that reads these tables ships.
-- Purely additive: new enums and tables, nothing existing is altered, so the currently
-- deployed client is unaffected.
--
-- Each foreign key to "User", "Post" or "Report" briefly takes a SHARE ROW EXCLUSIVE lock
-- on that table, and while it waits for in-flight writers every later write to it queues
-- behind it. Apply statement by statement (not inside one long transaction), with a lock
-- timeout so a busy table fails fast and can be retried instead of stalling writes:
SET lock_timeout = '3s';

-- CreateEnum
CREATE TYPE "StorylineStatus" AS ENUM ('Ongoing', 'Complete');

-- CreateTable
CREATE TABLE "Storyline" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "status" "StorylineStatus" NOT NULL DEFAULT 'Ongoing',
    "maxNsfwLevel" INTEGER NOT NULL,
    "tosViolation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Storyline_pkey" PRIMARY KEY ("id"),
    -- Exactly one NsfwLevel flag, PG (1) to XXX (16).
    CONSTRAINT "Storyline_maxNsfwLevel_check" CHECK ("maxNsfwLevel" IN (1, 2, 4, 8, 16))
);

CREATE INDEX "Storyline_userId_idx" ON "Storyline"("userId");

ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
-- No foreign key on "userId" on purpose: a deleted account must not cascade away a
-- chapter that other chapters hang from. "postId" is SET NULL for the same reason; a
-- chapter whose post is gone is a tombstone and its children stay reachable.
CREATE TABLE "StorylineChapter" (
    "id" SERIAL NOT NULL,
    "storylineId" INTEGER NOT NULL,
    "postId" INTEGER,
    "userId" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL,
    "placementId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineChapter_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorylineChapter_depth_check" CHECK ("depth" >= 0)
);

CREATE UNIQUE INDEX "StorylineChapter_postId_key" ON "StorylineChapter"("postId");
CREATE UNIQUE INDEX "StorylineChapter_placementId_key" ON "StorylineChapter"("placementId");
CREATE INDEX "StorylineChapter_storylineId_idx" ON "StorylineChapter"("storylineId");
CREATE INDEX "StorylineChapter_userId_idx" ON "StorylineChapter"("userId");
-- Target of the edge foreign keys below, which carry "storylineId" so an edge cannot join
-- chapters from two storylines.
CREATE UNIQUE INDEX "StorylineChapter_id_storylineId_key" ON "StorylineChapter"("id", "storylineId");
-- Exactly one first chapter per storyline. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX "StorylineChapter_storylineId_root_key" ON "StorylineChapter"("storylineId") WHERE "depth" = 0;

ALTER TABLE "StorylineChapter" ADD CONSTRAINT "StorylineChapter_storylineId_fkey" FOREIGN KEY ("storylineId") REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineChapter" ADD CONSTRAINT "StorylineChapter_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "StorylineChapterEdge" (
    "storylineId" INTEGER NOT NULL,
    "chapterId" INTEGER NOT NULL,
    "parentChapterId" INTEGER NOT NULL,
    "canon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineChapterEdge_pkey" PRIMARY KEY ("chapterId", "parentChapterId"),
    CONSTRAINT "StorylineChapterEdge_not_self_check" CHECK ("chapterId" <> "parentChapterId")
);

CREATE INDEX "StorylineChapterEdge_parentChapterId_idx" ON "StorylineChapterEdge"("parentChapterId");
-- v1: one parent per chapter. Drop this index to allow a chapter with several parents.
CREATE UNIQUE INDEX "StorylineChapterEdge_single_parent_key" ON "StorylineChapterEdge"("chapterId");
-- At most one canon (main route) child per parent. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX "StorylineChapterEdge_one_canon_key" ON "StorylineChapterEdge"("parentChapterId") WHERE "canon";

ALTER TABLE "StorylineChapterEdge" ADD CONSTRAINT "StorylineChapterEdge_chapterId_storylineId_fkey" FOREIGN KEY ("chapterId", "storylineId") REFERENCES "StorylineChapter"("id", "storylineId") ON DELETE CASCADE ON UPDATE CASCADE;
-- NO ACTION, not CASCADE: deleting a chapter row that still has children is refused rather
-- than cutting its subtree off from the root (take a chapter down by its post instead).
-- DEFERRABLE INITIALLY DEFERRED so the check runs at commit: deleting a whole storyline then
-- succeeds, because by commit the child-side cascade above has removed these edges. Checked
-- per statement instead, the storyline delete is refused too. Not expressible in Prisma.
ALTER TABLE "StorylineChapterEdge" ADD CONSTRAINT "StorylineChapterEdge_parentChapterId_storylineId_fkey" FOREIGN KEY ("parentChapterId", "storylineId") REFERENCES "StorylineChapter"("id", "storylineId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- CreateTable
CREATE TABLE "StorylineCollaborator" (
    "storylineId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineCollaborator_pkey" PRIMARY KEY ("storylineId", "userId")
);

CREATE INDEX "StorylineCollaborator_userId_idx" ON "StorylineCollaborator"("userId");

ALTER TABLE "StorylineCollaborator" ADD CONSTRAINT "StorylineCollaborator_storylineId_fkey" FOREIGN KEY ("storylineId") REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineCollaborator" ADD CONSTRAINT "StorylineCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "StorylineEarlyAccessSignup" (
    "userId" INTEGER NOT NULL,
    "storylineId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineEarlyAccessSignup_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "StorylineEarlyAccessSignup_createdAt_idx" ON "StorylineEarlyAccessSignup"("createdAt");

ALTER TABLE "StorylineEarlyAccessSignup" ADD CONSTRAINT "StorylineEarlyAccessSignup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "StorylineReport" (
    "storylineId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "StorylineReport_pkey" PRIMARY KEY ("reportId", "storylineId")
);

CREATE UNIQUE INDEX "StorylineReport_reportId_key" ON "StorylineReport"("reportId");
CREATE INDEX "StorylineReport_storylineId_idx" ON "StorylineReport" USING HASH ("storylineId");

ALTER TABLE "StorylineReport" ADD CONSTRAINT "StorylineReport_storylineId_fkey" FOREIGN KEY ("storylineId") REFERENCES "Storyline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineReport" ADD CONSTRAINT "StorylineReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
