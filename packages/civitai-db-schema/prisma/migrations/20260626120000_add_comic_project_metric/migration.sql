-- CreateTable
CREATE TABLE "ComicProjectMetric" (
    "comicProjectId" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tippedCount" INTEGER NOT NULL DEFAULT 0,
    "tippedAmountCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ComicProjectMetric_pkey" PRIMARY KEY ("comicProjectId")
);

-- AddForeignKey
ALTER TABLE "ComicProjectMetric" ADD CONSTRAINT "ComicProjectMetric_comicProjectId_fkey" FOREIGN KEY ("comicProjectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ComicProjectEngagement.updatedAt: lets the metric cron detect follow/hide/unfollow
-- changes incrementally (WHERE "updatedAt" > lastUpdate). Backfill existing rows
-- from createdAt so they aren't all treated as "just changed" on first run.
ALTER TABLE "ComicProjectEngagement" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "ComicProjectEngagement" SET "updatedAt" = "createdAt";

-- Seed ComicProjectMetric for ALL comics. The `comicProjectMetrics` cron is
-- INCREMENTAL (it only recomputes comics with activity since its last run), so
-- without this one-time full backfill, comics with no recent tips/engagement
-- would never get a row and would read 0. After this, the cron maintains deltas.
INSERT INTO "ComicProjectMetric" (
  "comicProjectId", "updatedAt",
  "tippedCount", "tippedAmountCount", "followerCount", "hiddenCount"
)
SELECT
  cp.id,
  NOW(),
  COALESCE(t."tippedCount", 0),
  COALESCE(t."tippedAmountCount", 0),
  COALESCE(e."followerCount", 0),
  COALESCE(e."hiddenCount", 0)
FROM "ComicProject" cp
LEFT JOIN (
  SELECT "entityId" AS id,
    COUNT(*)::int AS "tippedCount",
    COALESCE(SUM(amount), 0)::int AS "tippedAmountCount"
  FROM "BuzzTip" WHERE "entityType" = 'ComicProject' GROUP BY "entityId"
) t ON t.id = cp.id
LEFT JOIN (
  SELECT "projectId" AS id,
    COUNT(*) FILTER (WHERE type = 'Notify'::"ComicEngagementType")::int AS "followerCount",
    COUNT(*) FILTER (WHERE type = 'Hide'::"ComicEngagementType")::int  AS "hiddenCount"
  FROM "ComicProjectEngagement" GROUP BY "projectId"
) e ON e.id = cp.id
ON CONFLICT ("comicProjectId") DO NOTHING;
