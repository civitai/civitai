-- This is an empty migration.
DROP VIEW IF EXISTS public."ModelRank";
DROP VIEW IF EXISTS public."ModelVersionRank";

CREATE OR REPLACE VIEW public."ModelRank" AS
SELECT
	t."modelId",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingDay",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingYear",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
FROM (
	SELECT
		m.id AS "modelId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, m.Id DESC) AS "ratingCountRank",
		COALESCE(mm."rating", 0) AS "rating",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm.rating, 0) DESC, m.Id DESC) AS "ratingRank",
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
) t
GROUP BY t."modelId";

CREATE OR REPLACE VIEW public."ModelVersionRank" AS
SELECT
	t."modelVersionId",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountDay",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingDay",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountWeek",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountMonth",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountYear",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingYear",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::int)) AS "downloadCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::int)) AS "ratingCountAllTime",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(t.timeframe = 'Day'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(t.timeframe = 'Week'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(t.timeframe = 'Month'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(t.timeframe = 'Year'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
FROM (
	SELECT
		m.id AS "modelVersionId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, m.Id DESC) AS "ratingCountRank",
		COALESCE(mm."rating", 0) AS "rating",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm.rating, 0) DESC, m.Id DESC) AS "ratingRank",
		tf.timeframe
	FROM "ModelVersion" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelVersionMetric" mm ON mm."modelVersionId" = m.id AND mm.timeframe = tf.timeframe
) t
GROUP BY t."modelVersionId";