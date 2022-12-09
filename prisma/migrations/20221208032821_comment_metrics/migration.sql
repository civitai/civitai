-- AlterTable
ALTER TABLE "ModelMetric" ADD COLUMN     "commentCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ADD COLUMN     "commentCount" INTEGER NOT NULL DEFAULT 0;

DROP VIEW IF EXISTS public."ModelRank";

CREATE OR REPLACE VIEW public."ModelRank" AS
SELECT
	t."modelId",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountDay",
    MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."favoriteCount", NULL::int)) AS "favoriteCountDay",
    MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."commentCount", NULL::int)) AS "commentCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingDay",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountWeek",
    MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."favoriteCount", NULL::int)) AS "favoriteCountWeek",
    MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."commentCount", NULL::int)) AS "commentCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountMonth",
    MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."favoriteCount", NULL::int)) AS "favoriteCountMonth",
    MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."commentCount", NULL::int)) AS "commentCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountYear",
    MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."favoriteCount", NULL::int)) AS "favoriteCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."commentCount", NULL::int)) AS "commentCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingYear",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountAllTime",
    MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."favoriteCount", NULL::int)) AS "favoriteCountAllTime",
    MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."commentCount", NULL::int)) AS "commentCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
FROM (
	SELECT
		m.id AS "modelId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."ratingCount", 0) DESC, m.Id DESC) AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "ratingCountRank",
        COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."favoriteCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "favoriteCountRank",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."commentCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "commentCountRank",
		COALESCE(mm."rating", 0) AS "rating",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm.rating, 0) DESC, COALESCE(mm."ratingCount", 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "ratingRank",
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
) t
GROUP BY t."modelId"