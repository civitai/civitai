-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "commentCount" INTEGER NOT NULL DEFAULT 0;

-- Add Stats
CREATE OR REPLACE VIEW "ImageStat" AS
WITH timeframe_stats AS (
  SELECT
		i.id AS "imageId",
		COALESCE(mm."heartCount", 0) AS "heartCount",
		COALESCE(mm."likeCount", 0) AS "likeCount",
    COALESCE(mm."dislikeCount", 0) AS "dislikeCount",
    COALESCE(mm."laughCount", 0) AS "laughCount",
    COALESCE(mm."cryCount", 0) AS "cryCount",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		tf.timeframe
	FROM "Image" i
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ImageMetric" mm ON mm."imageId" = i.id AND mm.timeframe = tf.timeframe
)
SELECT
	"imageId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime"
FROM timeframe_stats
GROUP BY "imageId";

-- Add Rank
CREATE MATERIALIZED VIEW "ImageRank" AS
WITH timeframe_stats AS (
  SELECT
		i.id AS "imageId",
		COALESCE(im."heartCount", 0) AS "heartCount",
		COALESCE(im."likeCount", 0) AS "likeCount",
    COALESCE(im."dislikeCount", 0) AS "dislikeCount",
    COALESCE(im."laughCount", 0) AS "laughCount",
    COALESCE(im."cryCount", 0) AS "cryCount",
		COALESCE(im."commentCount", 0) AS "commentCount",
		COALESCE(im."heartCount" + im."likeCount" + im."dislikeCount" + im."laughCount" + im."cryCount", 0) AS "reactionCount",
		tf.timeframe
	FROM "Image" i
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = tf.timeframe
), timeframe_rank AS (
  SELECT
    "imageId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "imageId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "imageId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "imageId" DESC) AS "commentCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"imageId",
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
GROUP BY "imageId";

CREATE UNIQUE INDEX irank_image_id ON "ImageRank" ("imageId");