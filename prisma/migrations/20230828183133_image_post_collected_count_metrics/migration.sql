-- AlterTable
ALTER TABLE "ArticleMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0;

INSERT INTO "ArticleMetric" ("articleId", timeframe, "collectedCount")
SELECT
    ci."articleId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."articleId" IS NOT NULL
GROUP BY ci."articleId", tf.timeframe
ON CONFLICT ("articleId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "ImageMetric" ("imageId", timeframe, "collectedCount")
SELECT
    ci."imageId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."imageId" IS NOT NULL
GROUP BY ci."imageId", tf.timeframe
ON CONFLICT ("imageId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "PostMetric" ("postId", timeframe, "collectedCount")
SELECT
    ci."postId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(ci."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(ci."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(ci."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(ci."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM "CollectionItem" ci
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
WHERE ci."postId" IS NOT NULL
GROUP BY ci."postId", tf.timeframe
ON CONFLICT ("postId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

-- Article Rank View
drop view if exists "ArticleRank_Live";
create or replace view "ArticleRank_Live" as
WITH timeframe_stats AS (
	SELECT
		m."articleId",
		m."heartCount",
		m."likeCount",
		m."dislikeCount",
		m."laughCount",
		m."cryCount",
		m."commentCount",
		m."heartCount" + m."likeCount" + m."dislikeCount" + m."laughCount" +
		m."cryCount" AS "reactionCount",
		m."viewCount",
		m."favoriteCount",
		m."hideCount",
		m."collectedCount",
		m.timeframe
	FROM "ArticleMetric" m
), timeframe_rank AS (
	SELECT
		"articleId",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "articleId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "articleId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "commentCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("viewCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "viewCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("favoriteCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "favoriteCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("hideCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "hideCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("collectedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "collectedCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"articleId",
	MAX(iif(timeframe = 'Day', "heartCountRank", NULL)) AS "heartCountDayRank",
	MAX(iif(timeframe = 'Week', "heartCountRank", NULL)) AS "heartCountWeekRank",
	MAX(iif(timeframe = 'Month', "heartCountRank", NULL)) AS "heartCountMonthRank",
	MAX(iif(timeframe = 'Year', "heartCountRank", NULL)) AS "heartCountYearRank",
	MAX(iif(timeframe = 'AllTime', "heartCountRank", NULL)) AS "heartCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "likeCountRank", NULL)) AS "likeCountDayRank",
	MAX(iif(timeframe = 'Week', "likeCountRank", NULL)) AS "likeCountWeekRank",
	MAX(iif(timeframe = 'Month', "likeCountRank", NULL)) AS "likeCountMonthRank",
	MAX(iif(timeframe = 'Year', "likeCountRank", NULL)) AS "likeCountYearRank",
	MAX(iif(timeframe = 'AllTime', "likeCountRank", NULL)) AS "likeCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "dislikeCountRank", NULL)) AS "dislikeCountDayRank",
	MAX(iif(timeframe = 'Week', "dislikeCountRank", NULL)) AS "dislikeCountWeekRank",
	MAX(iif(timeframe = 'Month', "dislikeCountRank", NULL)) AS "dislikeCountMonthRank",
	MAX(iif(timeframe = 'Year', "dislikeCountRank", NULL)) AS "dislikeCountYearRank",
	MAX(iif(timeframe = 'AllTime', "dislikeCountRank", NULL)) AS "dislikeCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "laughCountRank", NULL)) AS "laughCountDayRank",
	MAX(iif(timeframe = 'Week', "laughCountRank", NULL)) AS "laughCountWeekRank",
	MAX(iif(timeframe = 'Month', "laughCountRank", NULL)) AS "laughCountMonthRank",
	MAX(iif(timeframe = 'Year', "laughCountRank", NULL)) AS "laughCountYearRank",
	MAX(iif(timeframe = 'AllTime', "laughCountRank", NULL)) AS "laughCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "cryCountRank", NULL)) AS "cryCountDayRank",
	MAX(iif(timeframe = 'Week', "cryCountRank", NULL)) AS "cryCountWeekRank",
	MAX(iif(timeframe = 'Month', "cryCountRank", NULL)) AS "cryCountMonthRank",
	MAX(iif(timeframe = 'Year', "cryCountRank", NULL)) AS "cryCountYearRank",
	MAX(iif(timeframe = 'AllTime', "cryCountRank", NULL)) AS "cryCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "reactionCountRank", NULL)) AS "reactionCountDayRank",
	MAX(iif(timeframe = 'Week', "reactionCountRank", NULL)) AS "reactionCountWeekRank",
	MAX(iif(timeframe = 'Month', "reactionCountRank", NULL)) AS "reactionCountMonthRank",
	MAX(iif(timeframe = 'Year', "reactionCountRank", NULL)) AS "reactionCountYearRank",
	MAX(iif(timeframe = 'AllTime', "reactionCountRank", NULL)) AS "reactionCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
	MAX(iif(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
	MAX(iif(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
	MAX(iif(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
	MAX(iif(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "viewCountRank", NULL)) AS "viewCountDayRank",
	MAX(iif(timeframe = 'Week', "viewCountRank", NULL)) AS "viewCountWeekRank",
	MAX(iif(timeframe = 'Month', "viewCountRank", NULL)) AS "viewCountMonthRank",
	MAX(iif(timeframe = 'Year', "viewCountRank", NULL)) AS "viewCountYearRank",
	MAX(iif(timeframe = 'AllTime', "viewCountRank", NULL)) AS "viewCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
	MAX(iif(timeframe = 'Week', "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
	MAX(iif(timeframe = 'Month', "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
	MAX(iif(timeframe = 'Year', "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
	MAX(iif(timeframe = 'AllTime', "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "hideCountRank", NULL)) AS "hideCountDayRank",
	MAX(iif(timeframe = 'Week', "hideCountRank", NULL)) AS "hideCountWeekRank",
	MAX(iif(timeframe = 'Month', "hideCountRank", NULL)) AS "hideCountMonthRank",
	MAX(iif(timeframe = 'Year', "hideCountRank", NULL)) AS "hideCountYearRank",
	MAX(iif(timeframe = 'AllTime', "hideCountRank", NULL)) AS "hideCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "collectedCountRank", NULL)) AS "collectedCountDayRank",
	MAX(iif(timeframe = 'Week', "collectedCountRank", NULL)) AS "collectedCountWeekRank",
	MAX(iif(timeframe = 'Month', "collectedCountRank", NULL)) AS "collectedCountMonthRank",
	MAX(iif(timeframe = 'Year', "collectedCountRank", NULL)) AS "collectedCountYearRank",
	MAX(iif(timeframe = 'AllTime', "collectedCountRank", NULL)) AS "collectedCountAllTimeRank"
FROM timeframe_rank
GROUP BY "articleId";

-- Posts Rank View
drop view if exists "PostRank_Live";
create view "PostRank_Live" as
WITH timeframe_stats as (
	SELECT
		"postId",
		"heartCount",
		"likeCount",
		"dislikeCount",
		"laughCount",
		"cryCount",
		"commentCount",
		"heartCount" + "likeCount" + "dislikeCount" + "laughCount" + "cryCount" "reactionCount",
		"collectedCount",
		timeframe
	FROM "PostMetric"
), timeframe_rank as (
	SELECT
		"postId",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "postId" DESC) "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "postId" DESC) "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "postId" DESC) "commentCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("collectedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "postId" DESC) "collectedCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"postId",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountAllTimeRank"
FROM timeframe_rank
GROUP BY "postId";

-- Images Rank View
drop view if exists "ImageRank_Live";
create view "ImageRank_Live" as
WITH timeframe_stats AS (
	SELECT
		"imageId",
		"heartCount",
		"likeCount",
		"dislikeCount",
		"laughCount",
		"cryCount",
		"commentCount",
		"collectedCount",
		"heartCount" + "likeCount" + "laughCount" + "cryCount" - "dislikeCount" AS "reactionCount",
		timeframe
	FROM "ImageMetric"
), timeframe_rank AS (
	SELECT
		"imageId",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "imageId" DESC ) AS "heartCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "imageId" DESC ) AS "likeCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "imageId" DESC ) AS "dislikeCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "imageId" DESC ) AS "laughCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "imageId" DESC ) AS "cryCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "imageId" DESC ) AS "reactionCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "imageId" DESC ) AS "commentCountRank",
		ROW_NUMBER() OVER ( PARTITION BY timeframe ORDER BY (COALESCE("collectedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "imageId" DESC ) AS "collectedCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"imageId",
	MAX(iif(timeframe = 'Day', "heartCountRank", NULL)) AS "heartCountDayRank",
	MAX(iif(timeframe = 'Week', "heartCountRank", NULL)) AS "heartCountWeekRank",
	MAX(iif(timeframe = 'Month', "heartCountRank", NULL)) AS "heartCountMonthRank",
	MAX(iif(timeframe = 'Year', "heartCountRank", NULL)) AS "heartCountYearRank",
	MAX(iif(timeframe = 'AllTime', "heartCountRank", NULL)) AS "heartCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "likeCountRank", NULL)) AS "likeCountDayRank",
	MAX(iif(timeframe = 'Week', "likeCountRank", NULL)) AS "likeCountWeekRank",
	MAX(iif(timeframe = 'Month', "likeCountRank", NULL)) AS "likeCountMonthRank",
	MAX(iif(timeframe = 'Year', "likeCountRank", NULL)) AS "likeCountYearRank",
	MAX(iif(timeframe = 'AllTime', "likeCountRank", NULL)) AS "likeCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "dislikeCountRank", NULL)) AS "dislikeCountDayRank",
	MAX(iif(timeframe = 'Week', "dislikeCountRank", NULL)) AS "dislikeCountWeekRank",
	MAX(iif(timeframe = 'Month', "dislikeCountRank", NULL)) AS "dislikeCountMonthRank",
	MAX(iif(timeframe = 'Year', "dislikeCountRank", NULL)) AS "dislikeCountYearRank",
	MAX(iif(timeframe = 'AllTime', "dislikeCountRank", NULL)) AS "dislikeCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "laughCountRank", NULL)) AS "laughCountDayRank",
	MAX(iif(timeframe = 'Week', "laughCountRank", NULL)) AS "laughCountWeekRank",
	MAX(iif(timeframe = 'Month', "laughCountRank", NULL)) AS "laughCountMonthRank",
	MAX(iif(timeframe = 'Year', "laughCountRank", NULL)) AS "laughCountYearRank",
	MAX(iif(timeframe = 'AllTime', "laughCountRank", NULL)) AS "laughCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "cryCountRank", NULL)) AS "cryCountDayRank",
	MAX(iif(timeframe = 'Week', "cryCountRank", NULL)) AS "cryCountWeekRank",
	MAX(iif(timeframe = 'Month', "cryCountRank", NULL)) AS "cryCountMonthRank",
	MAX(iif(timeframe = 'Year', "cryCountRank", NULL)) AS "cryCountYearRank",
	MAX(iif(timeframe = 'AllTime', "cryCountRank", NULL)) AS "cryCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "reactionCountRank", NULL)) AS "reactionCountDayRank",
	MAX(iif(timeframe = 'Week', "reactionCountRank", NULL)) AS "reactionCountWeekRank",
	MAX(iif(timeframe = 'Month', "reactionCountRank", NULL)) AS "reactionCountMonthRank",
	MAX(iif(timeframe = 'Year', "reactionCountRank", NULL)) AS "reactionCountYearRank",
	MAX(iif(timeframe = 'AllTime', "reactionCountRank", NULL)) AS "reactionCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
	MAX(iif(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
	MAX(iif(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
	MAX(iif(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
	MAX(iif(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "collectedCountRank", NULL)) AS "collectedCountDayRank",
	MAX(iif(timeframe = 'Week', "collectedCountRank", NULL)) AS "collectedCountWeekRank",
	MAX(iif(timeframe = 'Month', "collectedCountRank", NULL)) AS "collectedCountMonthRank",
	MAX(iif(timeframe = 'Year', "collectedCountRank", NULL)) AS "collectedCountYearRank",
	MAX(iif(timeframe = 'AllTime', "collectedCountRank", NULL)) AS "collectedCountAllTimeRank"
FROM timeframe_rank
GROUP BY "imageId";
