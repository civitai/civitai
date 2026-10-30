-- Storylines: who may continue a storyline; which way readers continue at the end of a chapter;
-- and who asked for the "Create next section" tool. The last two count signed-in readers once.
--
-- MANUAL APPLY: a human applies this per environment, after 20261023120000_storylines and
-- 20261023130000_storyline_children_index, BEFORE the code that reads these tables ships.
-- Purely additive: two new tables. Each foreign key to "User" briefly locks it; apply
-- statement by statement with a lock timeout so a busy table fails fast and can be retried.
SET lock_timeout = '3s';

-- Who may add continuations. A new enum and a column with a default on a new, small table.
CREATE TYPE "StorylineWhoCanContinue" AS ENUM ('Anyone', 'Collaborators');
ALTER TABLE "Storyline" ADD COLUMN "whoCanContinue" "StorylineWhoCanContinue" NOT NULL DEFAULT 'Anyone';

-- CreateTable
CREATE TABLE "StorylineBranchChoice" (
    "userId" INTEGER NOT NULL,
    "parentChapterId" INTEGER NOT NULL,
    "chapterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineBranchChoice_pkey" PRIMARY KEY ("userId", "parentChapterId")
);

CREATE INDEX "StorylineBranchChoice_parentChapterId_chapterId_idx" ON "StorylineBranchChoice"("parentChapterId", "chapterId");

ALTER TABLE "StorylineBranchChoice" ADD CONSTRAINT "StorylineBranchChoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineBranchChoice" ADD CONSTRAINT "StorylineBranchChoice_parentChapterId_fkey" FOREIGN KEY ("parentChapterId") REFERENCES "StorylineChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineBranchChoice" ADD CONSTRAINT "StorylineBranchChoice_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "StorylineChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "StorylineCreateClick" (
    "userId" INTEGER NOT NULL,
    "parentChapterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorylineCreateClick_pkey" PRIMARY KEY ("userId", "parentChapterId")
);

CREATE INDEX "StorylineCreateClick_createdAt_idx" ON "StorylineCreateClick"("createdAt");

ALTER TABLE "StorylineCreateClick" ADD CONSTRAINT "StorylineCreateClick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorylineCreateClick" ADD CONSTRAINT "StorylineCreateClick_parentChapterId_fkey" FOREIGN KEY ("parentChapterId") REFERENCES "StorylineChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
