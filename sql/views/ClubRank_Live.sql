 WITH timeframe_stats AS (
         SELECT m."clubId",
            m."memberCount",
            m."resourceCount",
            m."clubPostCount",
            m.timeframe
           FROM "ClubMetric" m
        ), timeframe_rank AS (
         SELECT timeframe_stats."clubId",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."memberCount", 0) DESC, COALESCE(timeframe_stats."resourceCount", 0) DESC, timeframe_stats."clubId" DESC) AS "memberCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."resourceCount", 0) DESC, COALESCE(timeframe_stats."clubPostCount", 0) DESC, timeframe_stats."clubId" DESC) AS "resourceCountRank",
            row_number() OVER (PARTITION BY timeframe_stats.timeframe ORDER BY COALESCE(timeframe_stats."clubPostCount", 0) DESC, COALESCE(timeframe_stats."memberCount", 0) DESC, timeframe_stats."clubId" DESC) AS "clubPostCountRank",
            timeframe_stats.timeframe
           FROM timeframe_stats
        )
 SELECT timeframe_rank."clubId",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."memberCountRank", NULL::bigint)) AS "memberCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."resourceCountRank", NULL::bigint)) AS "resourceCountAllTimeRank",
    max(iif((timeframe_rank.timeframe = 'Day'::"MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountDayRank",
    max(iif((timeframe_rank.timeframe = 'Week'::"MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountWeekRank",
    max(iif((timeframe_rank.timeframe = 'Month'::"MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountMonthRank",
    max(iif((timeframe_rank.timeframe = 'Year'::"MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountYearRank",
    max(iif((timeframe_rank.timeframe = 'AllTime'::"MetricTimeframe"), timeframe_rank."clubPostCountRank", NULL::bigint)) AS "clubPostCountAllTimeRank"
   FROM timeframe_rank
  GROUP BY timeframe_rank."clubId";