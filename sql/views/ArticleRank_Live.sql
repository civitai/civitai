 WITH timeframe_stats AS (
         SELECT m."articleId",
            m."heartCount",
            m."likeCount",
            m."dislikeCount",
            m."laughCount",
            m."cryCount",
            m."commentCount",
            ((((m."heartCount" + m."likeCount") + m."dislikeCount") + m."laughCount") + m."cryCount") AS "reactionCount",
            m."viewCount",
            m."favoriteCount",
            m."hideCount",
            m."collectedCount",
            m."tippedCount",
            m."tippedAmountCount",
            m.timeframe
           FROM "ArticleMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."articleId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."articleId" DESC) AS "heartCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, timeframe_stats."articleId" DESC) AS "likeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."dislikeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "dislikeCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."laughCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "laughCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."cryCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "cryCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."commentCount", 0) DESC, timeframe_stats."articleId" DESC) AS "reactionCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."commentCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "commentCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."viewCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "viewCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."favoriteCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "favoriteCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."hideCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "hideCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."collectedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "collectedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "tippedCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."tippedAmountCount", 0) DESC, COALESCE(timeframe_stats."reactionCount", 0) DESC, COALESCE(timeframe_stats."heartCount", 0) DESC, COALESCE(timeframe_stats."likeCount", 0) DESC, COALESCE(timeframe_stats."laughCount", 0) DESC, timeframe_stats."articleId" DESC) AS "tippedAmountCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."articleId",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."viewCountRank", NULL::bigint)) AS "viewCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."hideCountRank", NULL::bigint)) AS "hideCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."collectedCountRank", NULL::bigint)) AS "collectedCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."tippedCountRank", NULL::bigint)) AS "tippedCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."tippedAmountCountRank", NULL::bigint)) AS "tippedAmountCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."articleId";