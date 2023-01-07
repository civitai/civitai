-- AlterTable
BEGIN;
ALTER TABLE "UserMetric" ADD COLUMN     "reviewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "uploadCount" INTEGER NOT NULL DEFAULT 0;
COMMIT;

-- Drop affected views
DROP MATERIALIZED VIEW  "UserRank";
DROP VIEW IF EXISTS "UserStat";

-- Recreate affected views
CREATE VIEW "UserStat" AS
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
	  coalesce(sum(um."reviewCount"), 0) AS "reviewCount"
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
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "reviewCount", NULL)) AS "reviewCountAllTime"
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

CREATE MATERIALIZED VIEW "UserRank" AS
SELECT
  "userId",
  ROW_NUMBER() OVER (ORDER BY
    IIF ("userId" = -1, -100::double precision,
	    (
	      ("downloadCountMonth" / 100 * 1) +
		    ("ratingMonth" * "ratingCountMonth" * 10) +
		    ("favoriteCountMonth" * 5)
	    ) / (1 + 10 + 5)
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
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "downloadCountAllTime" DESC, "favoriteCountAllTime" DESC, "ratingCountAllTime" DESC, "userId") AS "followerCountAllTimeRank"
FROM "UserStat";

CREATE UNIQUE INDEX urank_user_id ON "UserRank" ("userId");