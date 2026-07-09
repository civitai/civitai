------------------------
-- Add Metric fields
------------------------
ALTER TABLE "ModelMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ModelVersionMetric" ADD COLUMN     "collectedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0;

INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "imageCount")
SELECT
    i."modelVersionId",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."publishedAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."publishedAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."publishedAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."publishedAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM (
    SELECT
        ir."modelVersionId",
        p."publishedAt"
    FROM "Image" i
    JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
    JOIN "Post" p ON i."postId" = p.id
    JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE p."publishedAt" < now() AND p."publishedAt" IS NOT NULL
      AND m."userId" != i."userId"
) i
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
GROUP BY i."modelVersionId", tf.timeframe
ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "imageCount" = EXCLUDED."imageCount";

INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "collectedCount")
SELECT
    mv."id",
    tf.timeframe,
    COALESCE(SUM(
        CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
        END
    ), 0)
FROM (
    SELECT
        "modelId",
        c."createdAt"
    FROM "CollectionItem" c
    JOIN "Model" m ON m.id = c."modelId"
    WHERE "modelId" IS NOT NULL
      AND m."userId" != c."addedById"
) i
JOIN "ModelVersion" mv ON mv."modelId" = i."modelId"
CROSS JOIN (
  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
) tf
GROUP BY mv."id", tf.timeframe
ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";

INSERT INTO "ModelMetric" ("modelId", timeframe, "imageCount", "collectedCount")
SELECT
  mv."modelId",
  mvm.timeframe,
  SUM(mvm."imageCount") "imageCount",
  MAX(mvm."collectedCount") "collectedCount"
FROM "ModelVersionMetric" mvm
JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
GROUP BY mv."modelId", mvm.timeframe
ON CONFLICT ("modelId", timeframe) DO UPDATE SET
  "imageCount" = EXCLUDED."imageCount",
  "collectedCount" = EXCLUDED."collectedCount";

------------------------
-- UPDATE Views
------------------------
drop view if exists "ModelRank_Live";
create view "ModelRank_Live" as
WITH model_timeframe_stats AS (
	SELECT
		m.id AS "modelId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."downloadCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."ratingCount", 0)) DESC, m.id DESC)   AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."ratingCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC)   AS "ratingCountRank",
		COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."favoriteCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "favoriteCountRank",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."commentCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC)  AS "commentCountRank",
		COALESCE(mm.rating, 0::double precision) AS rating,
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY ((COALESCE(mm.rating, 0::double precision) * COALESCE(mm."ratingCount", 0)::double precision + (3.5 * 10::numeric)::double precision) / (COALESCE(mm."ratingCount", 0) + 10)::double precision) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "ratingRank",
		ROW_NUMBER() OVER (ORDER BY (GREATEST(m."lastVersionAt", m."publishedAt")) DESC, m.id DESC) AS "newRank",
		DATE_PART('day'::text, NOW() - m."publishedAt"::timestamp WITH TIME ZONE) AS age_days,
		COALESCE(mm."imageCount", 0) AS "imageCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."imageCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "imageCountRank",
		COALESCE(mm."collectedCount", 0) AS "collectedCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."collectedCount", 0)) DESC, (COALESCE(mm.rating, 0::double precision)) DESC, (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "collectedCountRank",
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
)
SELECT
	model_timeframe_stats."modelId",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."downloadCount", NULL::integer)) AS "downloadCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."downloadCountRank", NULL::bigint))  AS "downloadCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."downloadCountRank", NULL::bigint))  AS "downloadCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."downloadCountRank", NULL::bigint))  AS "downloadCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."downloadCountRank", NULL::bigint))  AS "downloadCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."downloadCountRank", NULL::bigint))  AS "downloadCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."ratingCount", NULL::integer)) AS "ratingCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."ratingCountRank", NULL::bigint))  AS "ratingCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."ratingCountRank", NULL::bigint))  AS "ratingCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."ratingCountRank", NULL::bigint))  AS "ratingCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."ratingCountRank", NULL::bigint))  AS "ratingCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."ratingCountRank", NULL::bigint))  AS "ratingCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats.rating, NULL::double precision))    AS "ratingDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats.rating, NULL::double precision))    AS "ratingWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats.rating, NULL::double precision))    AS "ratingMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats.rating, NULL::double precision))    AS "ratingYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats.rating, NULL::double precision))    AS "ratingAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."ratingRank", NULL::bigint))  AS "ratingDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."ratingRank", NULL::bigint))  AS "ratingWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."ratingRank", NULL::bigint))  AS "ratingMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."ratingRank", NULL::bigint))  AS "ratingYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."ratingRank", NULL::bigint))  AS "ratingAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."favoriteCount", NULL::integer))AS "favoriteCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."favoriteCount", NULL::integer)) AS "favoriteCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."favoriteCountRank", NULL::bigint))  AS "favoriteCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."favoriteCountRank", NULL::bigint))  AS "favoriteCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."favoriteCountRank", NULL::bigint))  AS "favoriteCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."favoriteCountRank", NULL::bigint))  AS "favoriteCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."favoriteCountRank", NULL::bigint))  AS "favoriteCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."commentCount", NULL::integer)) AS "commentCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."commentCountRank", NULL::bigint))  AS "commentCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."commentCountRank", NULL::bigint))  AS "commentCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."commentCountRank", NULL::bigint))  AS "commentCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."commentCountRank", NULL::bigint))  AS "commentCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."commentCountRank", NULL::bigint))  AS "commentCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."imageCount", NULL::int))    AS "imageCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."imageCount", NULL:: int))    AS "imageCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."imageCount", NULL:: int))    AS "imageCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."imageCount", NULL:: int))    AS "imageCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."imageCount", NULL:: int))    AS "imageCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."imageCountRank", NULL::bigint))  AS "imageCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."imageCountRank", NULL::bigint))  AS "imageCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."imageCountRank", NULL::bigint))  AS "imageCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."imageCountRank", NULL::bigint))  AS "imageCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."imageCountRank", NULL::bigint))  AS "imageCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."collectedCount", NULL::int))    AS "collectedCountDay",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."collectedCount", NULL:: int))    AS "collectedCountWeek",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."collectedCount", NULL:: int))    AS "collectedCountMonth",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."collectedCount", NULL:: int))    AS "collectedCountYear",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."collectedCount", NULL:: int))    AS "collectedCountAllTime",
	MAX(iif(model_timeframe_stats.timeframe = 'Day'::"MetricTimeframe", model_timeframe_stats."collectedCountRank", NULL::bigint))  AS "collectedCountDayRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Week'::"MetricTimeframe", model_timeframe_stats."collectedCountRank", NULL::bigint))  AS "collectedCountWeekRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Month'::"MetricTimeframe", model_timeframe_stats."collectedCountRank", NULL::bigint))  AS "collectedCountMonthRank",
	MAX(iif(model_timeframe_stats.timeframe = 'Year'::"MetricTimeframe", model_timeframe_stats."collectedCountRank", NULL::bigint))  AS "collectedCountYearRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."collectedCountRank", NULL::bigint))  AS "collectedCountAllTimeRank",
	MAX(iif(model_timeframe_stats.timeframe = 'AllTime'::"MetricTimeframe", model_timeframe_stats."newRank", NULL::bigint))  AS "newRank",
	MAX(model_timeframe_stats.age_days) AS age_days
FROM model_timeframe_stats
GROUP BY model_timeframe_stats."modelId";

drop view if exists "ModelVersionRank_Live";
create view "ModelVersionRank_Live" AS
SELECT
	t."modelVersionId",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountDay",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountWeek",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountMonth",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountYear",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCount", NULL::integer)) AS "downloadCountAllTime",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountDay",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountWeek",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountMonth",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountYear",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCount", NULL::integer)) AS "ratingCountAllTime",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingDay",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingWeek",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingMonth",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingYear",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t.rating, NULL::double precision)) AS "ratingAllTime",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."ratingRank", NULL::bigint)) AS "ratingAllTimeRank",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."imageCount", NULL::integer)) AS "imageCountDay",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."imageCount", NULL::integer)) AS "imageCountWeek",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."imageCount", NULL::integer)) AS "imageCountMonth",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."imageCount", NULL::integer)) AS "imageCountYear",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."imageCount", NULL::integer)) AS "imageCountAllTime",
	MAX(iif(t.timeframe = 'Day'::"MetricTimeframe", t."imageCountRank", NULL::bigint)) AS "imageCountDayRank",
	MAX(iif(t.timeframe = 'Week'::"MetricTimeframe", t."imageCountRank", NULL::bigint)) AS "imageCountWeekRank",
	MAX(iif(t.timeframe = 'Month'::"MetricTimeframe", t."imageCountRank", NULL::bigint)) AS "imageCountMonthRank",
	MAX(iif(t.timeframe = 'Year'::"MetricTimeframe", t."imageCountRank", NULL::bigint)) AS "imageCountYearRank",
	MAX(iif(t.timeframe = 'AllTime'::"MetricTimeframe", t."imageCountRank", NULL::bigint)) AS "imageCountAllTimeRank"
FROM (
	SELECT
		m.id AS "modelVersionId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."downloadCount", 0)) DESC, m.id DESC) AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."ratingCount", 0)) DESC, m.id DESC) AS "ratingCountRank",
		COALESCE(mm.rating, 0::double precision) AS rating,
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm.rating, 0::double precision)) DESC, m.id DESC) AS "ratingRank",
		COALESCE(mm."imageCount", 0) AS "imageCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm."imageCount", 0)) DESC, m.id DESC) AS "imageCountRank",
		tf.timeframe
	FROM "ModelVersion" m
		CROSS JOIN (SELECT UNNEST(ENUM_RANGE(NULL::"MetricTimeframe")) AS timeframe) tf
		LEFT JOIN "ModelVersionMetric" mm ON mm."modelVersionId" = m.id AND mm.timeframe = tf.timeframe
) t
GROUP BY t."modelVersionId";

------------------------
-- DROP OLD STRUCTURE
------------------------
drop view "UserRank_Live";
drop view "UserStat";
drop view "PostResourceHelper";
drop view "ImageResourceHelper";
drop table "ModelRank";


------------------------
-- CREATE NEW STRUCTURE
------------------------
CREATE TABLE "ModelRank" AS SELECT * FROM "ModelRank_Live";
ALTER TABLE "ModelRank" ADD CONSTRAINT "pk_ModelRank" PRIMARY KEY ("modelId");
CREATE INDEX "ModelRank_idx" ON "ModelRank"("modelId");
CREATE INDEX "ModelRank_ratingWeekRank_idx" ON "ModelRank"("ratingWeekRank");
CREATE INDEX "ModelRank_ratingMonthRank_idx" ON "ModelRank"("ratingMonthRank");
CREATE INDEX "ModelRank_ratingYearRank_idx" ON "ModelRank"("ratingYearRank");
CREATE INDEX "ModelRank_ratingAllTimeRank_idx" ON "ModelRank"("ratingAllTimeRank");
CREATE INDEX "ModelRank_ratingDayRank_idx" ON "ModelRank"("ratingDayRank");
CREATE INDEX "ModelRank_favoriteCountWeekRank_idx" ON "ModelRank"("favoriteCountWeekRank");
CREATE INDEX "ModelRank_favoriteCountMonthRank_idx" ON "ModelRank"("favoriteCountMonthRank");
CREATE INDEX "ModelRank_favoriteCountYearRank_idx" ON "ModelRank"("favoriteCountYearRank");
CREATE INDEX "ModelRank_favoriteCountAllTimeRank_idx" ON "ModelRank"("favoriteCountAllTimeRank");
CREATE INDEX "ModelRank_favoriteCountDayRank_idx" ON "ModelRank"("favoriteCountDayRank");
CREATE INDEX "ModelRank_downloadCountWeekRank_idx" ON "ModelRank"("downloadCountWeekRank");
CREATE INDEX "ModelRank_downloadCountMonthRank_idx" ON "ModelRank"("downloadCountMonthRank");
CREATE INDEX "ModelRank_downloadCountYearRank_idx" ON "ModelRank"("downloadCountYearRank");
CREATE INDEX "ModelRank_downloadCountAllTimeRank_idx" ON "ModelRank"("downloadCountAllTimeRank");
CREATE INDEX "ModelRank_downloadCountDayRank_idx" ON "ModelRank"("downloadCountDayRank");
CREATE INDEX "ModelRank_commentCountWeekRank_idx" ON "ModelRank"("commentCountWeekRank");
CREATE INDEX "ModelRank_commentCountMonthRank_idx" ON "ModelRank"("commentCountMonthRank");
CREATE INDEX "ModelRank_commentCountYearRank_idx" ON "ModelRank"("commentCountYearRank");
CREATE INDEX "ModelRank_commentCountAllTimeRank_idx" ON "ModelRank"("commentCountAllTimeRank");
CREATE INDEX "ModelRank_commentCountDayRank_idx" ON "ModelRank"("commentCountDayRank");

create view "UserStat"
            ("userId", "followerCountDay", "followingCountDay", "hiddenCountDay", "followerCountWeek",
             "followingCountWeek", "hiddenCountWeek", "followerCountMonth", "followingCountMonth", "hiddenCountMonth",
             "followerCountYear", "followingCountYear", "hiddenCountYear", "followerCountAllTime",
             "followingCountAllTime", "hiddenCountAllTime", "uploadCountDay", "uploadCountWeek", "uploadCountMonth",
             "uploadCountYear", "uploadCountAllTime", "reviewCountDay", "reviewCountWeek", "reviewCountMonth",
             "reviewCountYear", "reviewCountAllTime", "answerCountDay", "answerCountWeek", "answerCountMonth",
             "answerCountYear", "answerCountAllTime", "answerAcceptCountDay", "answerAcceptCountWeek",
             "answerAcceptCountMonth", "answerAcceptCountYear", "answerAcceptCountAllTime", "downloadCountDay",
             "downloadCountWeek", "downloadCountMonth", "downloadCountYear", "downloadCountAllTime", "favoriteCountDay",
             "favoriteCountWeek", "favoriteCountMonth", "favoriteCountYear", "favoriteCountAllTime", "ratingCountDay",
             "ratingCountWeek", "ratingCountMonth", "ratingCountYear", "ratingCountAllTime", "ratingDay", "ratingWeek",
             "ratingMonth", "ratingYear", "ratingAllTime")
as
WITH user_model_counts AS (SELECT
	                           m."userId",
	                           SUM(mr."downloadCountDay")                                             AS "downloadCountDay",
	                           SUM(mr."downloadCountWeek")                                            AS "downloadCountWeek",
	                           SUM(mr."downloadCountMonth")                                           AS "downloadCountMonth",
	                           SUM(mr."downloadCountYear")                                            AS "downloadCountYear",
	                           SUM(mr."downloadCountAllTime")                                         AS "downloadCountAllTime",
	                           SUM(mr."favoriteCountDay")                                             AS "favoriteCountDay",
	                           SUM(mr."favoriteCountWeek")                                            AS "favoriteCountWeek",
	                           SUM(mr."favoriteCountMonth")                                           AS "favoriteCountMonth",
	                           SUM(mr."favoriteCountYear")                                            AS "favoriteCountYear",
	                           SUM(mr."favoriteCountAllTime")                                         AS "favoriteCountAllTime",
	                           SUM(mr."ratingCountDay")                                               AS "ratingCountDay",
	                           SUM(mr."ratingCountWeek")                                              AS "ratingCountWeek",
	                           SUM(mr."ratingCountMonth")                                             AS "ratingCountMonth",
	                           SUM(mr."ratingCountYear")                                              AS "ratingCountYear",
	                           SUM(mr."ratingCountAllTime")                                           AS "ratingCountAllTime",
	                           iif(SUM(mr."ratingCountDay") IS NULL OR SUM(mr."ratingCountDay") < 1, 0::double precision,
	                               SUM(mr."ratingDay" * mr."ratingCountDay"::double precision) /
	                               SUM(mr."ratingCountDay")::double precision)                        AS "ratingDay",
	                           iif(SUM(mr."ratingCountWeek") IS NULL OR SUM(mr."ratingCountWeek") < 1,
	                               0::double precision, SUM(mr."ratingWeek" * mr."ratingCountWeek"::double precision) /
	                                                    SUM(mr."ratingCountWeek")::double precision)  AS "ratingWeek",
	                           iif(SUM(mr."ratingCountMonth") IS NULL OR SUM(mr."ratingCountMonth") < 1,
	                               0::double precision, SUM(mr."ratingMonth" * mr."ratingCountMonth"::double precision) /
	                                                    SUM(mr."ratingCountMonth")::double precision) AS "ratingMonth",
	                           iif(SUM(mr."ratingCountYear") IS NULL OR SUM(mr."ratingCountYear") < 1,
	                               0::double precision, SUM(mr."ratingYear" * mr."ratingCountYear"::double precision) /
	                                                    SUM(mr."ratingCountYear")::double precision)  AS "ratingYear",
	                           iif(SUM(mr."ratingCountAllTime") IS NULL OR SUM(mr."ratingCountAllTime") < 1,
	                               0::double precision,
	                               SUM(mr."ratingAllTime" * mr."ratingCountAllTime"::double precision) /
	                               SUM(mr."ratingCountAllTime")::double precision)                    AS "ratingAllTime"
                           FROM "ModelRank" mr
                                JOIN "Model" m ON m.id = mr."modelId" AND m.status = 'Published'::"ModelStatus"
                           GROUP BY m."userId"),
     user_counts_timeframe AS (SELECT
	                               um."userId",
	                               um.timeframe,
	                               COALESCE(SUM(um."followingCount"), 0::bigint)    AS "followingCount",
	                               COALESCE(SUM(um."followerCount"), 0::bigint)     AS "followerCount",
	                               COALESCE(SUM(um."hiddenCount"), 0::bigint)       AS "hiddenCount",
	                               COALESCE(SUM(um."uploadCount"), 0::bigint)       AS "uploadCount",
	                               COALESCE(SUM(um."reviewCount"), 0::bigint)       AS "reviewCount",
	                               COALESCE(SUM(um."answerCount"), 0::bigint)       AS "answerCount",
	                               COALESCE(SUM(um."answerAcceptCount"), 0::bigint) AS "answerAcceptCount"
                               FROM "UserMetric" um
                               GROUP BY um."userId", um.timeframe),
     user_counts AS (SELECT
	                     user_counts_timeframe."userId",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."followerCount", NULL::bigint))     AS "followerCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."followingCount", NULL::bigint))    AS "followingCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."hiddenCount", NULL::bigint))       AS "hiddenCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."followerCount", NULL::bigint))     AS "followerCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."followingCount", NULL::bigint))    AS "followingCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."hiddenCount", NULL::bigint))       AS "hiddenCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."followerCount", NULL::bigint))     AS "followerCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."followingCount", NULL::bigint))    AS "followingCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."hiddenCount", NULL::bigint))       AS "hiddenCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."followerCount", NULL::bigint))     AS "followerCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."followingCount", NULL::bigint))    AS "followingCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."hiddenCount", NULL::bigint))       AS "hiddenCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."followerCount", NULL::bigint))     AS "followerCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."followingCount", NULL::bigint))    AS "followingCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."hiddenCount", NULL::bigint))       AS "hiddenCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."uploadCount", NULL::bigint))       AS "uploadCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."uploadCount", NULL::bigint))       AS "uploadCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."uploadCount", NULL::bigint))       AS "uploadCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."uploadCount", NULL::bigint))       AS "uploadCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."uploadCount", NULL::bigint))       AS "uploadCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."reviewCount", NULL::bigint))       AS "reviewCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."reviewCount", NULL::bigint))       AS "reviewCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."reviewCount", NULL::bigint))       AS "reviewCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."reviewCount", NULL::bigint))       AS "reviewCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."reviewCount", NULL::bigint))       AS "reviewCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."answerCount", NULL::bigint))       AS "answerCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."answerCount", NULL::bigint))       AS "answerCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."answerCount", NULL::bigint))       AS "answerCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."answerCount", NULL::bigint))       AS "answerCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."answerCount", NULL::bigint))       AS "answerCountAllTime",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Day'::"MetricTimeframe",
	                             user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountDay",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Week'::"MetricTimeframe",
	                             user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountWeek",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Month'::"MetricTimeframe",
	                             user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountMonth",
	                     MAX(iif(user_counts_timeframe.timeframe = 'Year'::"MetricTimeframe",
	                             user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountYear",
	                     MAX(iif(user_counts_timeframe.timeframe = 'AllTime'::"MetricTimeframe",
	                             user_counts_timeframe."answerAcceptCount", NULL::bigint)) AS "answerAcceptCountAllTime"
                     FROM user_counts_timeframe
                     GROUP BY user_counts_timeframe."userId"),
     full_user_stats AS (SELECT
	                         u."userId",
	                         u."followerCountDay",
	                         u."followingCountDay",
	                         u."hiddenCountDay",
	                         u."followerCountWeek",
	                         u."followingCountWeek",
	                         u."hiddenCountWeek",
	                         u."followerCountMonth",
	                         u."followingCountMonth",
	                         u."hiddenCountMonth",
	                         u."followerCountYear",
	                         u."followingCountYear",
	                         u."hiddenCountYear",
	                         u."followerCountAllTime",
	                         u."followingCountAllTime",
	                         u."hiddenCountAllTime",
	                         u."uploadCountDay",
	                         u."uploadCountWeek",
	                         u."uploadCountMonth",
	                         u."uploadCountYear",
	                         u."uploadCountAllTime",
	                         u."reviewCountDay",
	                         u."reviewCountWeek",
	                         u."reviewCountMonth",
	                         u."reviewCountYear",
	                         u."reviewCountAllTime",
	                         u."answerCountDay",
	                         u."answerCountWeek",
	                         u."answerCountMonth",
	                         u."answerCountYear",
	                         u."answerCountAllTime",
	                         u."answerAcceptCountDay",
	                         u."answerAcceptCountWeek",
	                         u."answerAcceptCountMonth",
	                         u."answerAcceptCountYear",
	                         u."answerAcceptCountAllTime",
	                         COALESCE(m."downloadCountDay", 0::bigint)        AS "downloadCountDay",
	                         COALESCE(m."downloadCountWeek", 0::bigint)       AS "downloadCountWeek",
	                         COALESCE(m."downloadCountMonth", 0::bigint)      AS "downloadCountMonth",
	                         COALESCE(m."downloadCountYear", 0::bigint)       AS "downloadCountYear",
	                         COALESCE(m."downloadCountAllTime", 0::bigint)    AS "downloadCountAllTime",
	                         COALESCE(m."favoriteCountDay", 0::bigint)        AS "favoriteCountDay",
	                         COALESCE(m."favoriteCountWeek", 0::bigint)       AS "favoriteCountWeek",
	                         COALESCE(m."favoriteCountMonth", 0::bigint)      AS "favoriteCountMonth",
	                         COALESCE(m."favoriteCountYear", 0::bigint)       AS "favoriteCountYear",
	                         COALESCE(m."favoriteCountAllTime", 0::bigint)    AS "favoriteCountAllTime",
	                         COALESCE(m."ratingCountDay", 0::bigint)          AS "ratingCountDay",
	                         COALESCE(m."ratingCountWeek", 0::bigint)         AS "ratingCountWeek",
	                         COALESCE(m."ratingCountMonth", 0::bigint)        AS "ratingCountMonth",
	                         COALESCE(m."ratingCountYear", 0::bigint)         AS "ratingCountYear",
	                         COALESCE(m."ratingCountAllTime", 0::bigint)      AS "ratingCountAllTime",
	                         COALESCE(m."ratingDay", 0::double precision)     AS "ratingDay",
	                         COALESCE(m."ratingWeek", 0::double precision)    AS "ratingWeek",
	                         COALESCE(m."ratingMonth", 0::double precision)   AS "ratingMonth",
	                         COALESCE(m."ratingYear", 0::double precision)    AS "ratingYear",
	                         COALESCE(m."ratingAllTime", 0::double precision) AS "ratingAllTime"
                         FROM user_counts u
                              LEFT JOIN user_model_counts m ON m."userId" = u."userId")
SELECT
	full_user_stats."userId",
	full_user_stats."followerCountDay",
	full_user_stats."followingCountDay",
	full_user_stats."hiddenCountDay",
	full_user_stats."followerCountWeek",
	full_user_stats."followingCountWeek",
	full_user_stats."hiddenCountWeek",
	full_user_stats."followerCountMonth",
	full_user_stats."followingCountMonth",
	full_user_stats."hiddenCountMonth",
	full_user_stats."followerCountYear",
	full_user_stats."followingCountYear",
	full_user_stats."hiddenCountYear",
	full_user_stats."followerCountAllTime",
	full_user_stats."followingCountAllTime",
	full_user_stats."hiddenCountAllTime",
	full_user_stats."uploadCountDay",
	full_user_stats."uploadCountWeek",
	full_user_stats."uploadCountMonth",
	full_user_stats."uploadCountYear",
	full_user_stats."uploadCountAllTime",
	full_user_stats."reviewCountDay",
	full_user_stats."reviewCountWeek",
	full_user_stats."reviewCountMonth",
	full_user_stats."reviewCountYear",
	full_user_stats."reviewCountAllTime",
	full_user_stats."answerCountDay",
	full_user_stats."answerCountWeek",
	full_user_stats."answerCountMonth",
	full_user_stats."answerCountYear",
	full_user_stats."answerCountAllTime",
	full_user_stats."answerAcceptCountDay",
	full_user_stats."answerAcceptCountWeek",
	full_user_stats."answerAcceptCountMonth",
	full_user_stats."answerAcceptCountYear",
	full_user_stats."answerAcceptCountAllTime",
	full_user_stats."downloadCountDay",
	full_user_stats."downloadCountWeek",
	full_user_stats."downloadCountMonth",
	full_user_stats."downloadCountYear",
	full_user_stats."downloadCountAllTime",
	full_user_stats."favoriteCountDay",
	full_user_stats."favoriteCountWeek",
	full_user_stats."favoriteCountMonth",
	full_user_stats."favoriteCountYear",
	full_user_stats."favoriteCountAllTime",
	full_user_stats."ratingCountDay",
	full_user_stats."ratingCountWeek",
	full_user_stats."ratingCountMonth",
	full_user_stats."ratingCountYear",
	full_user_stats."ratingCountAllTime",
	full_user_stats."ratingDay",
	full_user_stats."ratingWeek",
	full_user_stats."ratingMonth",
	full_user_stats."ratingYear",
	full_user_stats."ratingAllTime"
FROM full_user_stats;

create view "UserRank_Live" as
WITH user_positions AS (SELECT
	                        lr."userId",
	                        lr."leaderboardId",
	                        l.title,
	                        lr."position",
	                        ROW_NUMBER() OVER (PARTITION BY lr."userId" ORDER BY lr."position") AS row_num
                        FROM "User" u_1
                             JOIN "LeaderboardResult" lr ON lr."userId" = u_1.id
                             JOIN "Leaderboard" l ON l.id = lr."leaderboardId" AND l.public
                        WHERE lr.date = CURRENT_DATE
		                      AND (u_1."leaderboardShowcase" IS NULL OR lr."leaderboardId" = u_1."leaderboardShowcase")),
     lowest_position AS (SELECT
	                         up."userId",
	                         up."position",
	                         up."leaderboardId",
	                         up.title  AS "leaderboardTitle",
	                         (SELECT
		                          c.data ->> 'url'::text
	                          FROM "Cosmetic" c
	                          WHERE c."leaderboardId" = up."leaderboardId"
			                        AND up."position" <= c."leaderboardPosition"
	                          ORDER BY c."leaderboardPosition"
	                          LIMIT 1) AS "leaderboardCosmetic"
                         FROM user_positions up
                         WHERE up.row_num = 1)
SELECT
	us."userId",
	lp."position"                                                                                                                                             AS "leaderboardRank",
	lp."leaderboardId",
	lp."leaderboardTitle",
	lp."leaderboardCosmetic",
	ROW_NUMBER()
	OVER (ORDER BY us."downloadCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."userId")                        AS "downloadCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."favoriteCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."downloadCountDay" DESC, us."userId")                        AS "favoriteCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingCountDay" DESC, us."ratingDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId")                        AS "ratingCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId")                        AS "ratingDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."followerCountDay" DESC, us."downloadCountDay" DESC, us."favoriteCountDay" DESC, us."ratingCountDay" DESC, us."userId")                 AS "followerCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."downloadCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."userId")                    AS "downloadCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."favoriteCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."downloadCountWeek" DESC, us."userId")                    AS "favoriteCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingCountWeek" DESC, us."ratingWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId")                    AS "ratingCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId")                    AS "ratingWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."followerCountWeek" DESC, us."downloadCountWeek" DESC, us."favoriteCountWeek" DESC, us."ratingCountWeek" DESC, us."userId")             AS "followerCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."downloadCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."userId")                AS "downloadCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."favoriteCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."downloadCountMonth" DESC, us."userId")                AS "favoriteCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingCountMonth" DESC, us."ratingMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId")                AS "ratingCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId")                AS "ratingMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."followerCountMonth" DESC, us."downloadCountMonth" DESC, us."favoriteCountMonth" DESC, us."ratingCountMonth" DESC, us."userId")         AS "followerCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."downloadCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."userId")                    AS "downloadCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."favoriteCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."downloadCountYear" DESC, us."userId")                    AS "favoriteCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingCountYear" DESC, us."ratingYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId")                    AS "ratingCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId")                    AS "ratingYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."followerCountYear" DESC, us."downloadCountYear" DESC, us."favoriteCountYear" DESC, us."ratingCountYear" DESC, us."userId")             AS "followerCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."downloadCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."userId")        AS "downloadCountAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."favoriteCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId")        AS "favoriteCountAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingCountAllTime" DESC, us."ratingAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId")        AS "ratingCountAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId")        AS "ratingAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."followerCountAllTime" DESC, us."downloadCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."ratingCountAllTime" DESC, us."userId") AS "followerCountAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerCountDay" DESC, us."answerAcceptCountDay" DESC, us."userId")                                                                     AS "answerCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerCountWeek" DESC, us."answerAcceptCountWeek" DESC, us."userId")                                                                   AS "answerCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerCountMonth" DESC, us."answerAcceptCountMonth" DESC, us."userId")                                                                 AS "answerCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerCountYear" DESC, us."answerAcceptCountYear" DESC, us."userId")                                                                   AS "answerCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerCountAllTime" DESC, us."answerAcceptCountAllTime" DESC, us."userId")                                                             AS "answerCountAllTimeRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerAcceptCountDay" DESC, us."answerCountDay" DESC, us."userId")                                                                     AS "answerAcceptCountDayRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerAcceptCountWeek" DESC, us."answerCountWeek" DESC, us."userId")                                                                   AS "answerAcceptCountWeekRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerAcceptCountMonth" DESC, us."answerCountMonth" DESC, us."userId")                                                                 AS "answerAcceptCountMonthRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerAcceptCountYear" DESC, us."answerCountYear" DESC, us."userId")                                                                   AS "answerAcceptCountYearRank",
	ROW_NUMBER()
	OVER (ORDER BY us."answerAcceptCountAllTime" DESC, us."answerCountAllTime" DESC, us."userId")                                                             AS "answerAcceptCountAllTimeRank"
FROM "UserStat" us
     JOIN "User" u ON u.id = us."userId"
     LEFT JOIN lowest_position lp ON lp."userId" = us."userId";

create view "ImageResourceHelper"
            (id, "imageId", "reviewId", "reviewRating", "reviewDetails", "reviewCreatedAt", name, hash,
             "modelVersionId", "modelVersionName", "modelVersionCreatedAt", "modelId", "modelName", "modelRating",
             "modelRatingCount", "modelDownloadCount", "modelCommentCount", "modelFavoriteCount", "modelType", "postId")
as
SELECT
	ir.id,
	ir."imageId",
	rr.id                     AS "reviewId",
	rr.rating                 AS "reviewRating",
	rr.details                AS "reviewDetails",
	rr."createdAt"            AS "reviewCreatedAt",
	ir.name,
	ir.hash,
	mv.id                     AS "modelVersionId",
	mv.name                   AS "modelVersionName",
	mv."createdAt"            AS "modelVersionCreatedAt",
	m.id                      AS "modelId",
	m.name                    AS "modelName",
	mr."ratingAllTime"        AS "modelRating",
	mr."ratingCountAllTime"   AS "modelRatingCount",
	mr."downloadCountAllTime" AS "modelDownloadCount",
	mr."commentCountAllTime"  AS "modelCommentCount",
	mr."favoriteCountAllTime" AS "modelFavoriteCount",
	m.type                    AS "modelType",
	i."postId"
FROM "ImageResource" ir
     JOIN "Image" i ON i.id = ir."imageId"
     LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
     LEFT JOIN "Model" m ON m.id = mv."modelId"
     LEFT JOIN "ModelRank" mr ON mr."modelId" = m.id
     LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id AND rr."userId" = i."userId";

create view "PostResourceHelper"
            (id, "imageId", "reviewId", "reviewRating", "reviewDetails", "reviewCreatedAt", name, "modelVersionId",
             "modelVersionName", "modelVersionCreatedAt", "modelId", "modelName", "modelRating", "modelRatingCount",
             "modelDownloadCount", "modelCommentCount", "modelFavoriteCount", "modelType", "postId")
as
SELECT DISTINCT ON ("ImageResourceHelper"."postId", "ImageResourceHelper".name, "ImageResourceHelper"."modelVersionId")
	"ImageResourceHelper".id,
	"ImageResourceHelper"."imageId",
	"ImageResourceHelper"."reviewId",
	"ImageResourceHelper"."reviewRating",
	"ImageResourceHelper"."reviewDetails",
	"ImageResourceHelper"."reviewCreatedAt",
	"ImageResourceHelper".name,
	"ImageResourceHelper"."modelVersionId",
	"ImageResourceHelper"."modelVersionName",
	"ImageResourceHelper"."modelVersionCreatedAt",
	"ImageResourceHelper"."modelId",
	"ImageResourceHelper"."modelName",
	"ImageResourceHelper"."modelRating",
	"ImageResourceHelper"."modelRatingCount",
	"ImageResourceHelper"."modelDownloadCount",
	"ImageResourceHelper"."modelCommentCount",
	"ImageResourceHelper"."modelFavoriteCount",
	"ImageResourceHelper"."modelType",
	"ImageResourceHelper"."postId"
FROM "ImageResourceHelper";
