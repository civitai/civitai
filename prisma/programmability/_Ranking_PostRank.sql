DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'PostRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "PostRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "PostRank_Live";

CREATE VIEW "PostRank_Live" AS
WITH timeframe_stats AS (
  SELECT
		p.id AS "postId",
		COALESCE(im."heartCount", 0) AS "heartCount",
		COALESCE(im."likeCount", 0) AS "likeCount",
    COALESCE(im."dislikeCount", 0) AS "dislikeCount",
    COALESCE(im."laughCount", 0) AS "laughCount",
    COALESCE(im."cryCount", 0) AS "cryCount",
		COALESCE(im."commentCount", 0) AS "commentCount",
		COALESCE(im."heartCount" + im."likeCount" + im."dislikeCount" + im."laughCount" + im."cryCount", 0) AS "reactionCount",
		tf.timeframe
	FROM "Post" p
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "PostMetric" im ON im."postId" = p.id AND im.timeframe = tf.timeframe
), timeframe_rank AS (
  SELECT
    "postId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "postId" DESC) AS "commentCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"postId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank"
FROM timeframe_rank
GROUP BY "postId";