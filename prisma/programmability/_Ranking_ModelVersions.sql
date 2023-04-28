DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ModelVersionRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "ModelVersionRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "ModelVersionRank_Live";


CREATE VIEW public."ModelVersionRank_Live"
 AS
 SELECT t."modelVersionId",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountDay",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountDay",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingDay",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountWeek",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountWeek",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingWeek",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountMonth",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountMonth",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingMonth",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountYear",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountYear",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingYear",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountAllTime",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountAllTime",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingAllTime",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
    max(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingDayRank",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
    max(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
    max(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
    max(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingYearRank",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
    max(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
   FROM ( SELECT m.id AS "modelVersionId",
            COALESCE(mm."downloadCount", 0) AS "downloadCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "downloadCountRank",
            COALESCE(mm."ratingCount", 0) AS "ratingCount",
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."ratingCount", 0)) DESC, m.id DESC) AS "ratingCountRank",
            COALESCE(mm.rating, 0::double precision) AS rating,
            row_number() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm.rating, 0::double precision)) DESC, m.id DESC) AS "ratingRank",
            tf.timeframe
           FROM "ModelVersion" m
             CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
             LEFT JOIN "ModelVersionMetric" mm ON mm."modelVersionId" = m.id AND mm.timeframe = tf.timeframe) t
  GROUP BY t."modelVersionId";