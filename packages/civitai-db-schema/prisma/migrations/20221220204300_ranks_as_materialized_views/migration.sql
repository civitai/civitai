-- Model Rank
DROP VIEW "ModelRank";
CREATE MATERIALIZED VIEW "ModelRank" AS
WITH model_timeframe_stats AS (
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
		ROW_NUMBER() OVER (ORDER BY COALESCE(m."lastVersionAt", m."publishedAt") DESC, m.Id DESC) AS "newRank",
		date_part('day', now() - m."publishedAt") age_days,
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
), model_stats AS (
  SELECT
		"modelId",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountDay",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountDay",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountDay",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountDay",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "rating", NULL::float)) AS "ratingDay",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountWeek",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountWeek",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountWeek",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountWeek",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "rating", NULL::float)) AS "ratingWeek",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountMonth",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountMonth",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountMonth",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountMonth",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "rating", NULL::float)) AS "ratingMonth",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountYear",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountYear",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountYear",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountYear",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "rating", NULL::float)) AS "ratingYear",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountAllTime",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountAllTime",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountAllTime",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountAllTime",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "rating", NULL::float)) AS "ratingAllTime",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
		MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingDayRank",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
		MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingWeekRank",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
		MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingMonthRank",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
		MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingYearRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingAllTimeRank",
		MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "newRank", NULL::bigint)) AS "newRank",
		MAX(age_days) age_days
  FROM model_timeframe_stats
  GROUP BY "modelId"
), with_trend_score AS (
  SELECT
    *,
    (
		  (("favoriteCountDay" * 0.6 + "favoriteCountWeek" * 0.3 + "favoriteCountMonth" * 0.2  + "favoriteCountYear" * 0.1) / (0.6 + 0.3 + 0.2 + 0.1) * 0.4) +
		  ((LEAST("downloadCountDay", 400) * 0.6 + LEAST("downloadCountWeek", 1000) * 0.3 + LEAST("downloadCountMonth", 10000) * 0.2  + LEAST("downloadCountYear", 10000) * 0.1) / (0.6 + 0.3 + 0.2 + 0.1) * 0.3) +
		  (("commentCountDay" * 0.6 + "commentCountWeek" * 0.3 + "commentCountMonth" * 0.2  + "commentCountYear" * 0.1) / (0.6 + 0.3 + 0.2 + 0.1) * 0.3)
		) / (0.3 + 0.4 + 0.3) * EXP(-0.1 * age_days) "trendScore"
  FROM model_stats
)
SELECT
  *,
  ROW_NUMBER() OVER (ORDER BY COALESCE("trendScore", 0) DESC) AS "trendRank"
FROM with_trend_score;

-- UserRank
DROP VIEW "UserRank";
CREATE MATERIALIZED VIEW "UserRank" AS
SELECT
	"userId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCount", NULL)) AS "downloadCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCount", NULL)) AS "ratingCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "rating", NULL::float)) AS "ratingDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCount", NULL)) AS "downloadCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCount", NULL)) AS "ratingCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCount", NULL)) AS "downloadCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCount", NULL)) AS "ratingCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCount", NULL)) AS "downloadCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCount", NULL)) AS "ratingCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "rating", NULL::float)) AS "ratingYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCount", NULL)) AS "downloadCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCount", NULL)) AS "ratingCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCountRank", NULL)) AS "downloadCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCountRank", NULL)) AS "ratingCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCountRank", NULL)) AS "followerCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingRank", NULL)) AS "ratingDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCountRank", NULL)) AS "downloadCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCountRank", NULL)) AS "ratingCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCountRank", NULL)) AS "followerCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingRank", NULL)) AS "ratingWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCountRank", NULL)) AS "downloadCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCountRank", NULL)) AS "ratingCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCountRank", NULL)) AS "followerCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingRank", NULL)) AS "ratingMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCountRank", NULL)) AS "downloadCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCountRank", NULL)) AS "ratingCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCountRank", NULL)) AS "followerCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingRank", NULL)) AS "ratingYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCountRank", NULL)) AS "downloadCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCountRank", NULL)) AS "ratingCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCountRank", NULL)) AS "followerCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingRank", NULL)) AS "ratingAllTimeRank"
FROM (
	SELECT
	    u.*,
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("downloadCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, "userId") AS "downloadCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("favoriteCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "favoriteCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("ratingCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("followerCount", 0) DESC, COALESCE("downloadCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("ratingCount", 0) DESC, "userId") AS "followerCountRank"
	FROM (
		SELECT
	    u.id as "userId",
	    tf.timeframe,
	    coalesce(sum("downloadCount"), 0) AS "downloadCount",
	    coalesce(sum("favoriteCount"), 0) AS "favoriteCount",
	    coalesce(sum("ratingCount"), 0) AS "ratingCount",
	    coalesce(sum(um."followingCount"), 0) AS "followingCount",
	    coalesce(sum(um."followerCount"), 0) AS "followerCount",
	    coalesce(sum(um."hiddenCount"), 0) AS "hiddenCount",
	    IIF(sum("ratingCount") IS NULL OR sum("ratingCount") < 1, 0::double precision, sum("rating" * "ratingCount")/sum("ratingCount")) AS "rating"
		FROM "User" u
		CROSS JOIN (
			SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
		) tf
		LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = tf.timeframe
		LEFT JOIN (
			SELECT
				m."userId",
				COALESCE(sum(mm."downloadCount"), 0) AS "downloadCount",
				COALESCE(sum(mm."favoriteCount"), 0) AS "favoriteCount",
				COALESCE(sum(mm."ratingCount"), 0) AS "ratingCount",
				COALESCE(sum(mm."rating"), 0) AS "rating",
				tf.timeframe
			FROM "Model" m
			CROSS JOIN (
				SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
			) tf
			LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
			GROUP BY m."userId", tf.timeframe
		) m ON m."userId" = u.id AND tf.timeframe = m.timeframe
		GROUP BY u.id, tf.timeframe
	) u
) t
GROUP BY "userId";