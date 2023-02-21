DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'TagRank') THEN
        DROP MATERIALIZED VIEW public."TagRank";
    ELSE
        DROP VIEW IF EXISTS public."TagRank";
    END IF;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public."TagRank"
 AS
 SELECT "TagStat"."tagId",
    row_number() OVER (ORDER BY "TagStat"."followerCountDay" DESC, "TagStat"."modelCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId") AS "followerCountDayRank",
    row_number() OVER (ORDER BY "TagStat"."followerCountWeek" DESC, "TagStat"."modelCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId") AS "followerCountWeekRank",
    row_number() OVER (ORDER BY "TagStat"."followerCountMonth" DESC, "TagStat"."modelCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId") AS "followerCountMonthRank",
    row_number() OVER (ORDER BY "TagStat"."followerCountYear" DESC, "TagStat"."modelCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId") AS "followerCountYearRank",
    row_number() OVER (ORDER BY "TagStat"."followerCountAllTime" DESC, "TagStat"."modelCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId") AS "followerCountAllTimeRank",
    row_number() OVER (ORDER BY "TagStat"."hiddenCountDay" DESC, "TagStat"."modelCountDay" DESC, "TagStat"."followerCountDay", "TagStat"."tagId") AS "hiddenCountDayRank",
    row_number() OVER (ORDER BY "TagStat"."hiddenCountWeek" DESC, "TagStat"."modelCountWeek" DESC, "TagStat"."followerCountWeek", "TagStat"."tagId") AS "hiddenCountWeekRank",
    row_number() OVER (ORDER BY "TagStat"."hiddenCountMonth" DESC, "TagStat"."modelCountMonth" DESC, "TagStat"."followerCountMonth", "TagStat"."tagId") AS "hiddenCountMonthRank",
    row_number() OVER (ORDER BY "TagStat"."hiddenCountYear" DESC, "TagStat"."modelCountYear" DESC, "TagStat"."followerCountYear", "TagStat"."tagId") AS "hiddenCountYearRank",
    row_number() OVER (ORDER BY "TagStat"."hiddenCountAllTime" DESC, "TagStat"."modelCountAllTime" DESC, "TagStat"."followerCountAllTime", "TagStat"."tagId") AS "hiddenCountAllTimeRank",
    row_number() OVER (ORDER BY "TagStat"."modelCountDay" DESC, "TagStat"."followerCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId") AS "modelCountDayRank",
    row_number() OVER (ORDER BY "TagStat"."modelCountWeek" DESC, "TagStat"."followerCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId") AS "modelCountWeekRank",
    row_number() OVER (ORDER BY "TagStat"."modelCountMonth" DESC, "TagStat"."followerCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId") AS "modelCountMonthRank",
    row_number() OVER (ORDER BY "TagStat"."modelCountYear" DESC, "TagStat"."followerCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId") AS "modelCountYearRank",
    row_number() OVER (ORDER BY "TagStat"."modelCountAllTime" DESC, "TagStat"."followerCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId") AS "modelCountAllTimeRank",
    row_number() OVER (ORDER BY "TagStat"."imageCountDay" DESC, "TagStat"."followerCountDay" DESC, "TagStat"."hiddenCountDay", "TagStat"."tagId") AS "imageCountDayRank",
    row_number() OVER (ORDER BY "TagStat"."imageCountWeek" DESC, "TagStat"."followerCountWeek" DESC, "TagStat"."hiddenCountWeek", "TagStat"."tagId") AS "imageCountWeekRank",
    row_number() OVER (ORDER BY "TagStat"."imageCountMonth" DESC, "TagStat"."followerCountMonth" DESC, "TagStat"."hiddenCountMonth", "TagStat"."tagId") AS "imageCountMonthRank",
    row_number() OVER (ORDER BY "TagStat"."imageCountYear" DESC, "TagStat"."followerCountYear" DESC, "TagStat"."hiddenCountYear", "TagStat"."tagId") AS "imageCountYearRank",
    row_number() OVER (ORDER BY "TagStat"."imageCountAllTime" DESC, "TagStat"."followerCountAllTime" DESC, "TagStat"."hiddenCountAllTime", "TagStat"."tagId") AS "imageCountAllTimeRank"
   FROM "TagStat";

DROP INDEX IF EXISTS "TagRank_PK";
CREATE UNIQUE INDEX "TagRank_PK" ON "TagRank" ("tagId");

ALTER TABLE public."TagRank"
    OWNER TO modelshare;

DO $$
BEGIN
    IF EXISTS(SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'ModelVersionRank') THEN
        DROP MATERIALIZED VIEW public."ModelVersionRank";
    ELSE
        DROP VIEW IF EXISTS public."ModelVersionRank";
    END IF;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public."ModelVersionRank"
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

DROP INDEX IF EXISTS "ModelVersionRank_PK";
CREATE UNIQUE INDEX "ModelVersionRank_PK" ON "ModelVersionRank" ("modelVersionId");

ALTER TABLE public."ModelVersionRank"
    OWNER TO modelshare;



