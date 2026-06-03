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

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'UserRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "UserRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "UserRank_Live";

CREATE OR REPLACE VIEW "UserStat" AS
WITH user_model_counts AS (
  SELECT
	  "userId",
	  SUM("downloadCountDay") AS "downloadCountDay",
		SUM("downloadCountWeek") AS "downloadCountWeek",
		SUM("downloadCountMonth") AS "downloadCountMonth",
		SUM("downloadCountYear") AS "downloadCountYear",
		SUM("downloadCountAllTime") AS "downloadCountAllTime",
		SUM("favoriteCountDay") AS "favoriteCountDay",
		SUM("favoriteCountWeek") AS "favoriteCountWeek",
		SUM("favoriteCountMonth") AS "favoriteCountMonth",
		SUM("favoriteCountYear") AS "favoriteCountYear",
		SUM("favoriteCountAllTime") AS "favoriteCountAllTime",
		SUM("ratingCountDay") AS "ratingCountDay",
		SUM("ratingCountWeek") AS "ratingCountWeek",
		SUM("ratingCountMonth") AS "ratingCountMonth",
		SUM("ratingCountYear") AS "ratingCountYear",
		SUM("ratingCountAllTime") AS "ratingCountAllTime",
		IIF(sum("ratingCountDay") IS NULL OR sum("ratingCountDay") < 1, 0::double precision, sum("ratingDay" * "ratingCountDay")/sum("ratingCountDay")) AS "ratingDay",
		IIF(sum("ratingCountWeek") IS NULL OR sum("ratingCountWeek") < 1, 0::double precision, sum("ratingWeek" * "ratingCountWeek")/sum("ratingCountWeek")) AS "ratingWeek",
		IIF(sum("ratingCountMonth") IS NULL OR sum("ratingCountMonth") < 1, 0::double precision, sum("ratingMonth" * "ratingCountMonth")/sum("ratingCountMonth")) AS "ratingMonth",
		IIF(sum("ratingCountYear") IS NULL OR sum("ratingCountYear") < 1, 0::double precision, sum("ratingYear" * "ratingCountYear")/sum("ratingCountYear")) AS "ratingYear",
		IIF(sum("ratingCountAllTime") IS NULL OR sum("ratingCountAllTime") < 1, 0::double precision, sum("ratingAllTime" * "ratingCountAllTime")/sum("ratingCountAllTime")) AS "ratingAllTime"
	FROM "ModelRank" mr
	JOIN "Model" m ON m.id = mr."modelId"
	GROUP BY "userId"
), user_counts_timeframe AS (
	SELECT
	  u.id as "userId",
	  tf.timeframe,
	  coalesce(sum(um."followingCount"), 0) AS "followingCount",
	  coalesce(sum(um."followerCount"), 0) AS "followerCount",
	  coalesce(sum(um."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(um."uploadCount"), 0) AS "uploadCount",
	  coalesce(sum(um."reviewCount"), 0) AS "reviewCount",
	  coalesce(sum(um."answerCount"), 0) AS "answerCount",
	  coalesce(sum(um."answerAcceptCount"), 0) AS "answerAcceptCount"
	FROM "User" u
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = tf.timeframe
	GROUP BY u.id, tf.timeframe
), user_counts AS (
  SELECT
	"userId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followingCount", NULL)) AS "followingCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followingCount", NULL)) AS "followingCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followingCount", NULL)) AS "followingCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followingCount", NULL)) AS "followingCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followingCount", NULL)) AS "followingCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "uploadCount", NULL)) AS "uploadCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "uploadCount", NULL)) AS "uploadCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "uploadCount", NULL)) AS "uploadCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "uploadCount", NULL)) AS "uploadCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "uploadCount", NULL)) AS "uploadCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "answerCount", NULL)) AS "answerCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "answerCount", NULL)) AS "answerCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "answerCount", NULL)) AS "answerCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "answerCount", NULL)) AS "answerCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "answerCount", NULL)) AS "answerCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "answerAcceptCount", NULL)) AS "answerAcceptCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "answerAcceptCount", NULL)) AS "answerAcceptCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "answerAcceptCount", NULL)) AS "answerAcceptCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "answerAcceptCount", NULL)) AS "answerAcceptCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "answerAcceptCount", NULL)) AS "answerAcceptCountAllTime"
  from user_counts_timeframe
  GROUP BY "userId"
), full_user_stats AS (
  SELECT
	  u.*,
	  COALESCE("downloadCountDay", 0) AS "downloadCountDay",
		COALESCE("downloadCountWeek", 0) AS "downloadCountWeek",
		COALESCE("downloadCountMonth", 0) AS "downloadCountMonth",
		COALESCE("downloadCountYear", 0) AS "downloadCountYear",
		COALESCE("downloadCountAllTime", 0) AS "downloadCountAllTime",
		COALESCE("favoriteCountDay", 0) AS "favoriteCountDay",
		COALESCE("favoriteCountWeek", 0) AS "favoriteCountWeek",
		COALESCE("favoriteCountMonth", 0) AS "favoriteCountMonth",
		COALESCE("favoriteCountYear", 0) AS "favoriteCountYear",
		COALESCE("favoriteCountAllTime", 0) AS "favoriteCountAllTime",
		COALESCE("ratingCountDay", 0) AS "ratingCountDay",
		COALESCE("ratingCountWeek", 0) AS "ratingCountWeek",
		COALESCE("ratingCountMonth", 0) AS "ratingCountMonth",
		COALESCE("ratingCountYear", 0) AS "ratingCountYear",
		COALESCE("ratingCountAllTime", 0) AS "ratingCountAllTime",
		COALESCE("ratingDay", 0) AS "ratingDay",
		COALESCE("ratingWeek", 0) AS "ratingWeek",
		COALESCE("ratingMonth", 0) AS "ratingMonth",
		COALESCE("ratingYear", 0) AS "ratingYear",
		COALESCE("ratingAllTime", 0) AS "ratingAllTime"
	FROM user_counts u
	LEFT JOIN user_model_counts m ON m."userId" = u."userId"
)
SELECT
	*
FROM full_user_stats;

CREATE VIEW "UserRank_Live" AS
SELECT
  "userId",
  ROW_NUMBER() OVER (ORDER BY
    IIF ("userId" = -1 OR u."deletedAt" IS NOT NULL, -100::double precision,
	    (
	      ("downloadCountMonth" / 100 * 1) +
		    ("ratingMonth" * "ratingCountMonth" * 10) +
		    ("favoriteCountMonth" * 5) +
	      ("answerCountMonth" * 3) +
	      ("answerAcceptCountMonth" * 5)
	    ) / (1 + 10 + 5 + 3 + 5)
	  )
  DESC, "userId") AS "leaderboardRank",
  ROW_NUMBER() OVER (ORDER BY "downloadCountDay" DESC, "ratingDay" DESC, "ratingCountDay" DESC, "favoriteCountDay" DESC, "userId") AS "downloadCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "favoriteCountDay" DESC, "ratingDay" DESC, "ratingCountDay" DESC, "downloadCountDay" DESC, "userId") AS "favoriteCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "ratingCountDay" DESC, "ratingDay" DESC, "favoriteCountDay" DESC, "downloadCountDay" DESC, "userId") AS "ratingCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "ratingDay" DESC, "ratingCountDay" DESC, "favoriteCountDay" DESC, "downloadCountDay" DESC, "userId") AS "ratingDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "downloadCountDay" DESC, "favoriteCountDay" DESC, "ratingCountDay" DESC, "userId") AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "downloadCountWeek" DESC, "ratingWeek" DESC, "ratingCountWeek" DESC, "favoriteCountWeek" DESC, "userId") AS "downloadCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "favoriteCountWeek" DESC, "ratingWeek" DESC, "ratingCountWeek" DESC, "downloadCountWeek" DESC, "userId") AS "favoriteCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "ratingCountWeek" DESC, "ratingWeek" DESC, "favoriteCountWeek" DESC, "downloadCountWeek" DESC, "userId") AS "ratingCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "ratingWeek" DESC, "ratingCountWeek" DESC, "favoriteCountWeek" DESC, "downloadCountWeek" DESC, "userId") AS "ratingWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "downloadCountWeek" DESC, "favoriteCountWeek" DESC, "ratingCountWeek" DESC, "userId") AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "downloadCountMonth" DESC, "ratingMonth" DESC, "ratingCountMonth" DESC, "favoriteCountMonth" DESC, "userId") AS "downloadCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "favoriteCountMonth" DESC, "ratingMonth" DESC, "ratingCountMonth" DESC, "downloadCountMonth" DESC, "userId") AS "favoriteCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "ratingCountMonth" DESC, "ratingMonth" DESC, "favoriteCountMonth" DESC, "downloadCountMonth" DESC, "userId") AS "ratingCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "ratingMonth" DESC, "ratingCountMonth" DESC, "favoriteCountMonth" DESC, "downloadCountMonth" DESC, "userId") AS "ratingMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "downloadCountMonth" DESC, "favoriteCountMonth" DESC, "ratingCountMonth" DESC, "userId") AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "downloadCountYear" DESC, "ratingYear" DESC, "ratingCountYear" DESC, "favoriteCountYear" DESC, "userId") AS "downloadCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "favoriteCountYear" DESC, "ratingYear" DESC, "ratingCountYear" DESC, "downloadCountYear" DESC, "userId") AS "favoriteCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "ratingCountYear" DESC, "ratingYear" DESC, "favoriteCountYear" DESC, "downloadCountYear" DESC, "userId") AS "ratingCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "ratingYear" DESC, "ratingCountYear" DESC, "favoriteCountYear" DESC, "downloadCountYear" DESC, "userId") AS "ratingYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "downloadCountYear" DESC, "favoriteCountYear" DESC, "ratingCountYear" DESC, "userId") AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "downloadCountAllTime" DESC, "ratingAllTime" DESC, "ratingCountAllTime" DESC, "favoriteCountAllTime" DESC, "userId") AS "downloadCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "favoriteCountAllTime" DESC, "ratingAllTime" DESC, "ratingCountAllTime" DESC, "downloadCountAllTime" DESC, "userId") AS "favoriteCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "ratingCountAllTime" DESC, "ratingAllTime" DESC, "favoriteCountAllTime" DESC, "downloadCountAllTime" DESC, "userId") AS "ratingCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "ratingAllTime" DESC, "ratingCountAllTime" DESC, "favoriteCountAllTime" DESC, "downloadCountAllTime" DESC, "userId") AS "ratingAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "downloadCountAllTime" DESC, "favoriteCountAllTime" DESC, "ratingCountAllTime" DESC, "userId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountDay" DESC, "answerAcceptCountDay" DESC, "userId") AS "answerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountWeek" DESC, "answerAcceptCountWeek" DESC, "userId") AS "answerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountMonth" DESC, "answerAcceptCountMonth" DESC, "userId") AS "answerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountYear" DESC, "answerAcceptCountYear" DESC, "userId") AS "answerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountAllTime" DESC, "answerAcceptCountAllTime" DESC, "userId") AS "answerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountDay" DESC, "answerCountDay" DESC, "userId") AS "answerAcceptCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountWeek" DESC, "answerCountWeek" DESC, "userId") AS "answerAcceptCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountMonth" DESC, "answerCountMonth" DESC, "userId") AS "answerAcceptCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountYear" DESC, "answerCountYear" DESC, "userId") AS "answerAcceptCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountAllTime" DESC, "answerCountAllTime" DESC, "userId") AS "answerAcceptCountAllTimeRank"
FROM "UserStat" us
JOIN "User" u ON u."id" = us."userId";

CREATE TABLE "UserRank"
    AS SELECT * FROM "UserRank_Live";

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ImageRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "ImageRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "ImageStat";
DROP VIEW IF EXISTS "ImageRank_Live";

CREATE OR REPLACE VIEW "ImageStat" AS
WITH timeframe_stats AS (
  SELECT
		i.id AS "imageId",
		COALESCE(mm."heartCount", 0) AS "heartCount",
		COALESCE(mm."likeCount", 0) AS "likeCount",
    COALESCE(mm."dislikeCount", 0) AS "dislikeCount",
    COALESCE(mm."laughCount", 0) AS "laughCount",
    COALESCE(mm."cryCount", 0) AS "cryCount",
		COALESCE(mm."commentCount", 0) AS "commentCount",
		tf.timeframe
	FROM "Image" i
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ImageMetric" mm ON mm."imageId" = i.id AND mm.timeframe = tf.timeframe
)
SELECT
	"imageId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime"
FROM timeframe_stats
GROUP BY "imageId";

-- Add Rank
CREATE VIEW "ImageRank_Live" AS
WITH timeframe_stats AS (
  SELECT
		i.id AS "imageId",
		COALESCE(im."heartCount", 0) AS "heartCount",
		COALESCE(im."likeCount", 0) AS "likeCount",
    COALESCE(im."dislikeCount", 0) AS "dislikeCount",
    COALESCE(im."laughCount", 0) AS "laughCount",
    COALESCE(im."cryCount", 0) AS "cryCount",
		COALESCE(im."commentCount", 0) AS "commentCount",
		COALESCE(im."heartCount" + im."likeCount" + im."dislikeCount" + im."laughCount" + im."cryCount", 0) AS "reactionCount",
		tf.timeframe
	FROM "Image" i
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "ImageMetric" im ON im."imageId" = i.id AND im.timeframe = tf.timeframe
), timeframe_rank AS (
  SELECT
    "imageId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "imageId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "imageId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "imageId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "imageId" DESC) AS "commentCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"imageId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank"
FROM timeframe_rank
GROUP BY "imageId";

CREATE TABLE "ImageRank"
  AS SELECT * FROM "ImageRank_Live";

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

  CREATE TABLE "ModelVersionRank"
    AS SELECT * FROM "ModelVersionRank_Live";

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'PostRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "PostRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "PostRank_Live";

CREATE VIEW "PostRank_Live" AS
WITH timeframe_stats AS (
  SELECT
		p.id AS "postId",
		COALESCE(im."heartCount", 0) AS "heartCount",
		COALESCE(im."likeCount", 0) AS "likeCount",
    COALESCE(im."dislikeCount", 0) AS "dislikeCount",
    COALESCE(im."laughCount", 0) AS "laughCount",
    COALESCE(im."cryCount", 0) AS "cryCount",
		COALESCE(im."commentCount", 0) AS "commentCount",
		COALESCE(im."heartCount" + im."likeCount" + im."dislikeCount" + im."laughCount" + im."cryCount", 0) AS "reactionCount",
		tf.timeframe
	FROM "Post" p
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "PostMetric" im ON im."postId" = p.id AND im.timeframe = tf.timeframe
), timeframe_rank AS (
  SELECT
    "postId",
    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("likeCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, "postId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("dislikeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("laughCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("cryCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("commentCount", 0) DESC, "postId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("commentCount", 0) DESC, COALESCE("reactionCount", 0) DESC, COALESCE("heartCount", 0) DESC, COALESCE("likeCount", 0) DESC, COALESCE("laughCount", 0) DESC, "postId" DESC) AS "commentCountRank",
    timeframe
  FROM timeframe_stats
)
SELECT
	"postId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL::bigint)) AS "heartCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL::bigint)) AS "likeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL::bigint)) AS "dislikeCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL::bigint)) AS "laughCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL::bigint)) AS "cryCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL::bigint)) AS "reactionCountAllTimeRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL::bigint)) AS "commentCountAllTimeRank"
FROM timeframe_rank
GROUP BY "postId";

CREATE TABLE "PostRank"
  AS SELECT * FROM "PostRank_Live";

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'TagRank' AND relkind = 'm') THEN
        DROP MATERIALIZED VIEW IF EXISTS "TagRank";
    END IF;
END $$;
DROP VIEW IF EXISTS "TagRank_Live";
DROP VIEW IF EXISTS "TagStat";

CREATE VIEW "TagStat" AS
WITH stats_timeframe AS (
	SELECT
	  t.id,
	  tf.timeframe,
	  coalesce(sum(tm."followerCount"), 0) AS "followerCount",
	  coalesce(sum(tm."hiddenCount"), 0) AS "hiddenCount",
	  coalesce(sum(tm."modelCount"), 0) AS "modelCount",
	  coalesce(sum(tm."imageCount"), 0) AS "imageCount",
	  coalesce(sum(tm."postCount"), 0) AS "postCount"
	FROM "Tag" t
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "TagMetric" tm ON tm."tagId" = t.id AND tm.timeframe = tf.timeframe
	GROUP BY t.id, tf.timeframe
)
SELECT
id "tagId",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL)) AS "followerCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "modelCount", NULL)) AS "modelCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "imageCount", NULL)) AS "imageCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "postCount", NULL)) AS "postCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "postCount", NULL)) AS "postCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "postCount", NULL)) AS "postCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "postCount", NULL)) AS "postCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "postCount", NULL)) AS "postCountAllTime"
from stats_timeframe
GROUP BY "id";

-- Add TagRank_Live
CREATE VIEW "TagRank_Live" AS
SELECT
  "tagId",
	ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "modelCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "followerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "modelCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "followerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "modelCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "followerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "modelCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "followerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "modelCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountDay" DESC, "modelCountDay" DESC, "followerCountDay" ASC, "tagId") AS "hiddenCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountWeek" DESC, "modelCountWeek" DESC, "followerCountWeek" ASC, "tagId") AS "hiddenCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountMonth" DESC, "modelCountMonth" DESC, "followerCountMonth" ASC, "tagId") AS "hiddenCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountYear" DESC, "modelCountYear" DESC, "followerCountYear" ASC, "tagId") AS "hiddenCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "hiddenCountAllTime" DESC, "modelCountAllTime" DESC, "followerCountAllTime" ASC, "tagId") AS "hiddenCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "modelCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "modelCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "modelCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "modelCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "modelCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "modelCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountDay" DESC, "followerCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "imageCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountWeek" DESC, "followerCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "imageCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountMonth" DESC, "followerCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "imageCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountYear" DESC, "followerCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "imageCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "imageCountAllTime" DESC, "followerCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "imageCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "postCountDay" DESC,  "imageCountDay" DESC, "hiddenCountDay" ASC, "tagId") AS "postCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "postCountWeek" DESC, "imageCountWeek" DESC, "hiddenCountWeek" ASC, "tagId") AS "postCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "postCountMonth" DESC, "imageCountMonth" DESC, "hiddenCountMonth" ASC, "tagId") AS "postCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "postCountYear" DESC, "imageCountYear" DESC, "hiddenCountYear" ASC, "tagId") AS "postCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "postCountAllTime" DESC, "imageCountAllTime" DESC, "hiddenCountAllTime" ASC, "tagId") AS "postCountAllTimeRank"
FROM "TagStat";

CREATE TABLE "TagRank"
  AS SELECT * FROM "TagRank_Live";