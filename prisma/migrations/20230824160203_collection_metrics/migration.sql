-- CreateTable
CREATE TABLE "CollectionMetric" (
    "collectionId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "contributorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CollectionMetric_pkey" PRIMARY KEY ("collectionId","timeframe")
);

-- AddForeignKey
ALTER TABLE "CollectionMetric" ADD CONSTRAINT "CollectionMetric_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Collection Stats
DROP VIEW IF EXISTS "CollectionStat";
CREATE VIEW "CollectionStat" AS
WITH stats_timeframe AS (
	SELECT
	  m."collectionId",
	  m.timeframe,
	  coalesce(sum(m."followerCount"), 0) AS "followerCount",
	  coalesce(sum(m."contributorCount"), 0) AS "contributorCount",
	  coalesce(sum(m."itemCount"), 0) AS "itemCount"
	FROM "CollectionMetric" m
	GROUP BY m."collectionId", m.timeframe
)
SELECT
"collectionId",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "contributorCount", NULL)) AS "contributorCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "contributorCount", NULL)) AS "contributorCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "contributorCount", NULL)) AS "contributorCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "contributorCount", NULL)) AS "contributorCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "contributorCount", NULL)) AS "contributorCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "itemCount", NULL)) AS "itemCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "itemCount", NULL)) AS "itemCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "itemCount", NULL)) AS "itemCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "itemCount", NULL)) AS "itemCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "itemCount", NULL)) AS "itemCountAllTime"
from stats_timeframe
GROUP BY "collectionId";

-- Collection Rank
DROP VIEW IF EXISTS  "CollectionRank_Live";
CREATE VIEW "CollectionRank_Live" AS
SELECT
  "collectionId",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "itemCountDay" DESC, "collectionId") AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "itemCountWeek" DESC, "collectionId") AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "itemCountMonth" DESC, "collectionId") AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "itemCountYear" DESC, "collectionId") AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "itemCountAllTime" DESC, "collectionId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "itemCountDay" DESC, "followerCountDay" DESC, "collectionId") AS "itemCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "itemCountWeek" DESC, "followerCountWeek" DESC, "collectionId") AS "itemCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "itemCountMonth" DESC, "followerCountMonth" DESC, "collectionId") AS "itemCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "itemCountYear" DESC, "followerCountYear" DESC, "collectionId") AS "itemCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "itemCountAllTime" DESC, "followerCountAllTime" DESC, "collectionId") AS "itemCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "contributorCountDay" DESC, "followerCountDay" DESC, "collectionId") AS "contributorCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "contributorCountWeek" DESC, "followerCountWeek" DESC, "collectionId") AS "contributorCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "contributorCountMonth" DESC, "followerCountMonth" DESC, "collectionId") AS "contributorCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "contributorCountYear" DESC, "followerCountYear" DESC, "collectionId") AS "contributorCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "contributorCountAllTime" DESC, "followerCountAllTime" DESC, "collectionId") AS "contributorCountAllTimeRank"
FROM "CollectionStat";
