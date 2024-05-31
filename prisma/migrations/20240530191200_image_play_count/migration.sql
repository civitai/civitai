
-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "playCount" INTEGER NOT NULL DEFAULT 0;

-- TODO.justin: check this
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
		COALESCE(mm."collectedCount", 0) AS "collectedCount",
		COALESCE(mm."tippedCount", 0) AS "tippedCount",
		COALESCE(mm."tippedAmountCount", 0) AS "tippedAmountCount",
		COALESCE(mm."viewCount", 0) AS "viewCount",
		COALESCE(mm."playCount", 0) AS "playCount",
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
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "collectedCount", NULL::integer)) AS "collectedCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "collectedCount", NULL::integer)) AS "collectedCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "collectedCount", NULL::integer)) AS "collectedCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "collectedCount", NULL::integer)) AS "collectedCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "collectedCount", NULL::integer)) AS "collectedCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime"
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountAllTime"
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "playCount", NULL::integer)) AS "playCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "playCount", NULL::integer)) AS "playCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "playCount", NULL::integer)) AS "playCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "playCount", NULL::integer)) AS "playCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "playCount", NULL::integer)) AS "playCountAllTime"

FROM timeframe_stats
GROUP BY "imageId";
