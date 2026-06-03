CREATE OR REPLACE VIEW public."UserRank" AS
SELECT
	"userId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountDay",
    MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "rating", NULL::float)) AS "ratingDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountWeek",
    MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountMonth",
    MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountYear",
    MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "rating", NULL::float)) AS "ratingYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountAllTime",
    MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
FROM (
	SELECT
	    u.*,
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("downloadCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, "userId") AS "downloadCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("favoriteCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "favoriteCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("ratingCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingRank"
	FROM (
		SELECT
		    u.id as "userId",
		    tf.timeframe,
		    coalesce(sum("downloadCount"), 0) AS "downloadCount",
		    coalesce(sum("favoriteCount"), 0) AS "favoriteCount",
		    coalesce(sum("ratingCount"), 0) AS "ratingCount",
		    IIF(sum("ratingCount") IS NULL OR sum("ratingCount") < 1, 0::double precision, sum("rating")/sum("ratingCount")) AS "rating"
		FROM "User" u
		CROSS JOIN (
			SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
		) tf
		LEFT JOIN (
			SELECT
				m."userId",
				m.id AS "modelId",
				COALESCE(mm."downloadCount", 0) AS "downloadCount",
				COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
				COALESCE(mm."ratingCount", 0) AS "ratingCount",
				COALESCE(mm."rating", 0) AS "rating",
				tf.timeframe
			FROM "Model" m
			CROSS JOIN (
				SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
			) tf
			LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
		) m ON m."userId" = u.id AND tf.timeframe = m.timeframe
		GROUP BY u.id, tf.timeframe
	) u
) t
GROUP BY "userId"