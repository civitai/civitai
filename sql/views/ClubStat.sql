 WITH stats_timeframe AS (
         SELECT m."clubId",
            m.timeframe,
            COALESCE(m."memberCount", 0) AS "memberCount",
            COALESCE(m."resourceCount", 0) AS "resourceCount",
            COALESCE(m."clubPostCount", 0) AS "clubPostCount"
           FROM "ClubMetric" m
          GROUP BY m."clubId", m.timeframe
        )
 SELECT stats_timeframe."clubId",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."memberCount", NULL::integer)) AS "memberCountAllTime",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."resourceCount", NULL::integer)) AS "resourceCountAllTime",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."clubPostCount", NULL::integer)) AS "clubPostCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."clubId";