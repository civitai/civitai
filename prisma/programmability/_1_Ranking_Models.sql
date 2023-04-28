-- This script drops UserRank_Live as a reuslt
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ModelRank' AND relkind = 'm') THEN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'UserRank' AND relkind = 'm') THEN
            DROP MATERIALIZED VIEW "UserRank";
        END IF;
        DROP VIEW IF EXISTS "UserRank_Live";
        DROP VIEW IF EXISTS "UserStat";
        DROP VIEW IF EXISTS "PostResourceHelper";
        DROP VIEW IF EXISTS "ImageResourceHelper";
        DROP MATERIALIZED VIEW "ModelRank";
    END IF;
END $$;

DROP VIEW IF EXISTS "ModelRank_Live";

CREATE VIEW "ModelRank_Live" AS
WITH model_timeframe_stats AS (
  SELECT
		m.id AS "modelId",
		COALESCE(mm."downloadCount", 0) AS "downloadCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."downloadCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."ratingCount", 0) DESC, m.Id DESC) AS "downloadCountRank",
		COALESCE(mm."ratingCount", 0) AS "ratingCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."ratingCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "ratingCountRank",
        COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."favoriteCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "favoriteCountRank",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(mm."commentCount", 0) DESC, COALESCE(mm.rating, 0) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "commentCountRank",
		COALESCE(mm."rating", 0) AS "rating",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY (COALESCE(mm.rating, 0) * 0.8) + (COALESCE(mm."ratingCount", 0) * 0.2) DESC, COALESCE(mm."downloadCount", 0) DESC, m.Id DESC) AS "ratingRank",
		ROW_NUMBER() OVER (ORDER BY GREATEST(m."lastVersionAt", m."publishedAt") DESC, m.Id DESC) AS "newRank",
		date_part('day', now() - m."publishedAt") age_days,
		tf.timeframe
	FROM "Model" m
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
)
SELECT
	"modelId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "rating", NULL::float)) AS "ratingDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "rating", NULL::float)) AS "ratingYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCount", NULL::int)) AS "downloadCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCount", NULL::int)) AS "ratingCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL::int)) AS "favoriteCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::int)) AS "commentCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "newRank", NULL::bigint)) AS "newRank",
	MAX(age_days) age_days
FROM model_timeframe_stats
GROUP BY "modelId";

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ModelRank' AND relkind = 'r') THEN
        CREATE TABLE "ModelRank"
            AS SELECT * FROM "ModelRank_Live";

    -- Create ImageResourceHelper View
    CREATE
    OR REPLACE VIEW "ImageResourceHelper" AS
    SELECT
      ir.id "id",
      ir."imageId",
      rr.id "reviewId",
      rr.rating "reviewRating",
      rr.details "reviewDetails",
      rr."createdAt" "reviewCreatedAt",
      ir.name,
      mv.id "modelVersionId",
      mv.name "modelVersionName",
      mv."createdAt" "modelVersionCreatedAt",
      m.id "modelId",
      m.name "modelName",
      mr."ratingAllTime" "modelRating",
      mr."ratingCountAllTime" "modelRatingCount",
      mr."downloadCountAllTime" "modelDownloadCount",
      mr."commentCountAllTime" "modelCommentCount",
      mr."favoriteCountAllTime" "modelFavoriteCount",
      m.type "modelType",
      i."postId" "postId"
    FROM
      "ImageResource" ir
      JOIN "Image" i ON i.id = ir."imageId"
      LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
      LEFT JOIN "Model" m ON m.id = mv."modelId"
      LEFT JOIN "ModelRank" mr ON mr."modelId" = m.id
      LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id
      AND rr."userId" = i."userId";

    -- Create PostResourceHelper View
    CREATE
    OR REPLACE VIEW "PostResourceHelper" AS
    SELECT
      DISTINCT ON ("postId", "name", "modelVersionId") *
    FROM
      "ImageResourceHelper";
    END IF;
END $$;