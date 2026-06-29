-- Per-(user, chapter) read records keyed by the STABLE ComicChapter.id, replacing
-- the fragile position-array on ComicProjectEngagement.readChapters (which had to be
-- wiped on every reorder/republish because positions shift). Drives
-- readerCount/chapterReadCount in ComicProjectMetric. `unread` is a soft-delete flag
-- so the incremental cron detects un-reads via `updatedAt` instead of drifting.

-- CreateTable
CREATE TABLE "ComicChapterRead" (
    "userId"    INTEGER NOT NULL,
    "chapterId" INTEGER NOT NULL,
    "unread"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComicChapterRead_pkey" PRIMARY KEY ("userId", "chapterId")
);

-- CreateIndex
CREATE INDEX "ComicChapterRead_chapterId_idx" ON "ComicChapterRead"("chapterId");
CREATE INDEX "ComicChapterRead_updatedAt_idx" ON "ComicChapterRead"("updatedAt");

-- AddForeignKey
ALTER TABLE "ComicChapterRead" ADD CONSTRAINT "ComicChapterRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicChapterRead" ADD CONSTRAINT "ComicChapterRead_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "ComicChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New metric columns
ALTER TABLE "ComicProjectMetric" ADD COLUMN "readerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ComicProjectMetric" ADD COLUMN "chapterReadCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill reads from the old position-array WHILE POSITIONS ARE STILL VALID:
-- resolve each (projectId, position) to the stable ComicChapter.id. updatedAt is
-- seeded from the engagement's createdAt so existing rows aren't all treated as
-- "just changed" on the cron's first run.
INSERT INTO "ComicChapterRead" ("userId", "chapterId", "unread", "createdAt", "updatedAt")
SELECT e."userId", cc.id, false, e."createdAt", e."createdAt"
FROM "ComicProjectEngagement" e
CROSS JOIN LATERAL unnest(e."readChapters") AS pos("position")
JOIN "ComicChapter" cc ON cc."projectId" = e."projectId" AND cc."position" = pos."position"
ON CONFLICT ("userId", "chapterId") DO NOTHING;

-- Backfill ComicProjectMetric read counters from the new table (metric rows already
-- exist for every comic from the initial seed migration; comics with no reads keep 0).
UPDATE "ComicProjectMetric" m
SET "readerCount" = r."readerCount",
    "chapterReadCount" = r."chapterReadCount",
    "updatedAt" = NOW()
FROM (
  SELECT cc."projectId" AS id,
    COUNT(DISTINCT cr."userId")::int AS "readerCount",
    COUNT(*)::int AS "chapterReadCount"
  FROM "ComicChapterRead" cr
  JOIN "ComicChapter" cc ON cc.id = cr."chapterId"
  WHERE cr."unread" = false
  GROUP BY cc."projectId"
) r
WHERE m."comicProjectId" = r.id;

-- NOTE: `ComicProjectEngagement.readChapters` is intentionally NOT dropped here.
-- Read state now lives in ComicChapterRead (backfilled above), but the old column
-- is kept (unused) for one release as a safety net — so the backfill + new read
-- path can be verified in prod before the source data is destroyed. A follow-up
-- migration drops the column once verified. (The Prisma schema already omits it;
-- Prisma harmlessly ignores the extra DB column in the interim.)
