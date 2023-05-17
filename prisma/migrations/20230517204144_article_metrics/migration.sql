/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "ArticleMetric" ADD COLUMN     "favoriteCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hideCount" INTEGER NOT NULL DEFAULT 0;

-- Adjust rank view
drop view if exists "ArticleRank_Live";
create view "ArticleRank_Live" AS
WITH timeframe_stats AS (
	SELECT
		"articleId",
		"heartCount",
		"likeCount",
		"dislikeCount",
		"laughCount",
		"cryCount",
		"commentCount",
		"heartCount" + "likeCount" + "dislikeCount" + "laughCount" + "cryCount" AS "reactionCount",
		"viewCount" AS "viewCount",
		"favoriteCount",
		"hideCount",
		timeframe
	FROM "ArticleMetric" m
), timeframe_rank AS (
	SELECT
		timeframe_stats."articleId",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."dislikeCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."laughCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."cryCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."commentCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."commentCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."laughCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "commentCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."viewCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."laughCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "viewCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."favoriteCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."laughCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "favoriteCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY (COALESCE(timeframe_stats."hideCount", 0)) DESC, (COALESCE(timeframe_stats."reactionCount", 0)) DESC, (COALESCE(timeframe_stats."heartCount", 0)) DESC, (COALESCE(timeframe_stats."likeCount", 0)) DESC, (COALESCE(timeframe_stats."laughCount", 0)) DESC, timeframe_stats."articleId" DESC) AS "hideCountRank",
		timeframe_stats.timeframe
	FROM timeframe_stats
)
SELECT
	timeframe_rank."articleId",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."heartCountRank", NULL::bigint))::integer AS "heartCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."heartCountRank", NULL::bigint))::integer AS "heartCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."heartCountRank", NULL::bigint))::integer AS "heartCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."heartCountRank", NULL::bigint))::integer AS "heartCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."heartCountRank", NULL::bigint))::integer AS "heartCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."likeCountRank", NULL::bigint))::integer AS "likeCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."likeCountRank", NULL::bigint))::integer AS "likeCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."likeCountRank", NULL::bigint))::integer AS "likeCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."likeCountRank", NULL::bigint))::integer AS "likeCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."likeCountRank", NULL::bigint))::integer AS "likeCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."dislikeCountRank", NULL::bigint))::integer AS "dislikeCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."dislikeCountRank", NULL::bigint))::integer AS "dislikeCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."dislikeCountRank", NULL::bigint))::integer AS "dislikeCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."dislikeCountRank", NULL::bigint))::integer AS "dislikeCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."dislikeCountRank", NULL::bigint))::integer AS "dislikeCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."laughCountRank", NULL::bigint))::integer AS "laughCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."laughCountRank", NULL::bigint))::integer AS "laughCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."laughCountRank", NULL::bigint))::integer AS "laughCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."laughCountRank", NULL::bigint))::integer AS "laughCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."laughCountRank", NULL::bigint))::integer AS "laughCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."cryCountRank", NULL::bigint))::integer AS "cryCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."cryCountRank", NULL::bigint))::integer AS "cryCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."cryCountRank", NULL::bigint))::integer AS "cryCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."cryCountRank", NULL::bigint))::integer AS "cryCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."cryCountRank", NULL::bigint))::integer AS "cryCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."reactionCountRank", NULL::bigint))::integer AS "reactionCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."reactionCountRank", NULL::bigint))::integer AS "reactionCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."reactionCountRank", NULL::bigint))::integer AS "reactionCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."reactionCountRank", NULL::bigint))::integer AS "reactionCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."reactionCountRank", NULL::bigint))::integer AS "reactionCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."commentCountRank", NULL::bigint))::integer AS "commentCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."commentCountRank", NULL::bigint))::integer AS "commentCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."commentCountRank", NULL::bigint))::integer AS "commentCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."commentCountRank", NULL::bigint))::integer AS "commentCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."commentCountRank", NULL::bigint))::integer AS "commentCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."viewCountRank", NULL::bigint))::integer AS "viewCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."viewCountRank", NULL::bigint))::integer AS "viewCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."viewCountRank", NULL::bigint))::integer AS "viewCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."viewCountRank", NULL::bigint))::integer AS "viewCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."viewCountRank", NULL::bigint))::integer AS "viewCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."favoriteCountRank", NULL::bigint))::integer AS "favoriteCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."favoriteCountRank", NULL::bigint))::integer AS "favoriteCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."favoriteCountRank", NULL::bigint))::integer AS "favoriteCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."favoriteCountRank", NULL::bigint))::integer AS "favoriteCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."favoriteCountRank", NULL::bigint))::integer AS "favoriteCountAllTimeRank",
	MAX(iif(timeframe_rank.timeframe = 'Day'::"MetricTimeframe", timeframe_rank."hideCountRank", NULL::bigint))::integer AS "hideCountDayRank",
	MAX(iif(timeframe_rank.timeframe = 'Week'::"MetricTimeframe", timeframe_rank."hideCountRank", NULL::bigint))::integer AS "hideCountWeekRank",
	MAX(iif(timeframe_rank.timeframe = 'Month'::"MetricTimeframe", timeframe_rank."hideCountRank", NULL::bigint))::integer AS "hideCountMonthRank",
	MAX(iif(timeframe_rank.timeframe = 'Year'::"MetricTimeframe", timeframe_rank."hideCountRank", NULL::bigint))::integer AS "hideCountYearRank",
	MAX(iif(timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe", timeframe_rank."hideCountRank", NULL::bigint))::integer AS "hideCountAllTimeRank"
FROM timeframe_rank
GROUP BY timeframe_rank."articleId";