-- AlterTable
ALTER TABLE "TagsOnModels" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Update createdAt on tagsOnModels
UPDATE "TagsOnModels" t
SET "createdAt" = COALESCE(m."publishedAt", m."updatedAt")
FROM "Model" m
WHERE t."modelId" = m.id;

-- CreateTable
CREATE TABLE "TagMetric" (
    "tagId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "modelCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TagMetric_pkey" PRIMARY KEY ("tagId","timeframe")
);

-- AddForeignKey
ALTER TABLE "TagMetric" ADD CONSTRAINT "TagMetric_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add Stats View
CREATE VIEW "TagStat" AS
WITH stats_timeframe AS (
	SELECT
	  t.id,
	  tf.timeframe,
	  coalesce(sum(tm."followerCount"), 0) AS "followerCount",
	  coalesce(sum(tm."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(tm."modelCount"), 0) AS "modelCount"
	FROM "Tag" t
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "TagMetric" tm ON tm."tagId" = t.id AND tm.timeframe = tf.timeframe
	GROUP BY t.id, tf.timeframe
)
SELECT
id "tagId",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountAllTime"
from stats_timeframe
GROUP BY "id";

-- Add Rank view
CREATE VIEW "TagRank" AS
SELECT
  "tagId",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "modelCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "modelCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "modelCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "modelCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "modelCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountDay" DESC, "modelCountDay" DESC, "followerCountDay" ASC, "tagId") AS "hiddenCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountWeek" DESC, "modelCountWeek" DESC, "followerCountWeek" ASC, "tagId") AS "hiddenCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountMonth" DESC, "modelCountMonth" DESC, "followerCountMonth" ASC, "tagId") AS "hiddenCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountYear" DESC, "modelCountYear" DESC, "followerCountYear" ASC, "tagId") AS "hiddenCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountAllTime" DESC, "modelCountAllTime" DESC, "followerCountAllTime" ASC, "tagId") AS "hiddenCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "modelCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "modelCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "modelCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "modelCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "modelCountAllTimeRank"
FROM "TagStat";