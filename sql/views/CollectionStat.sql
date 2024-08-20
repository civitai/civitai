 WITH stats_timeframe AS (
         SELECT m."collectionId",
            m.timeframe,
            COALESCE(sum(m."followerCount"), (0)::bigint) AS "followerCount",
            COALESCE(sum(m."contributorCount"), (0)::bigint) AS "contributorCount",
            COALESCE(sum(m."itemCount"), (0)::bigint) AS "itemCount"
           FROM "CollectionMetric" m
          GROUP BY m."collectionId", m.timeframe
        )
 SELECT stats_timeframe."collectionId",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."followerCount", NULL::bigint)) AS "followerCountAllTime",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."contributorCount", NULL::bigint)) AS "contributorCountAllTime",
    max(iif((stats_timeframe.timeframe = 'Day'::"MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountDay",
    max(iif((stats_timeframe.timeframe = 'Week'::"MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountWeek",
    max(iif((stats_timeframe.timeframe = 'Month'::"MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountMonth",
    max(iif((stats_timeframe.timeframe = 'Year'::"MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountYear",
    max(iif((stats_timeframe.timeframe = 'AllTime'::"MetricTimeframe"), stats_timeframe."itemCount", NULL::bigint)) AS "itemCountAllTime"
   FROM stats_timeframe
  GROUP BY stats_timeframe."collectionId";