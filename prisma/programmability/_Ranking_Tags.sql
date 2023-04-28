DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'TagRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "TagRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "TagRank_Live";
DROP VIEW IF EXISTS "TagStat";

CREATE VIEW "TagStat" AS
WITH stats_timeframe AS (
	SELECT
	  t.id,
	  tf.timeframe,
	  coalesce(sum(tm."followerCount"), 0) AS "followerCount",
	  coalesce(sum(tm."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(tm."modelCount"), 0) AS "modelCount",
	  coalesce(sum(tm."imageCount"), 0) AS "imageCount",
	  coalesce(sum(tm."postCount"), 0) AS "postCount"
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
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "postCount", NULL)) AS "postCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "postCount", NULL)) AS "postCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "postCount", NULL)) AS "postCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "postCount", NULL)) AS "postCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "postCount", NULL)) AS "postCountAllTime"
from stats_timeframe
GROUP BY "id";

-- Add TagRank_Live
CREATE VIEW "TagRank_Live" AS
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
	ROW_NUMBER() OVER (ORDER BY "modelCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "modelCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "imageCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "imageCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "imageCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "imageCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "imageCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "postCountDay" DESC,  "imageCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "postCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "postCountWeek" DESC, "imageCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "postCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "postCountMonth" DESC, "imageCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "postCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "postCountYear" DESC, "imageCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "postCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "postCountAllTime" DESC, "imageCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "postCountAllTimeRank"
FROM "TagStat";