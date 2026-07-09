DROP MATERIALIZED VIEW IF EXISTS  "UserRank";
DROP VIEW IF EXISTS "UserStat";

-- User Stats
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
	  coalesce(sum(um."hiddenCount"), 0) AS "hiddenCount"
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
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "hiddenCount", NULL)) AS "hiddenCountAllTime"
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

-- User Rank
CREATE MATERIALIZED VIEW "UserRank" AS
SELECT
  "userId",
  ROW_NUMBER() OVER (ORDER BY COALESCE("downloadCountDay", 0) DESC, COALESCE("ratingDay", 0) DESC, COALESCE("ratingCountDay", 0) DESC, COALESCE("favoriteCountDay", 0) DESC, "userId") AS "downloadCountRankDay",
	ROW_NUMBER() OVER (ORDER BY COALESCE("favoriteCountDay", 0) DESC, COALESCE("ratingDay", 0) DESC, COALESCE("ratingCountDay", 0) DESC, COALESCE("downloadCountDay", 0) DESC, "userId") AS "favoriteCountRankDay",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingCountDay", 0) DESC, COALESCE("ratingDay", 0) DESC, COALESCE("favoriteCountDay", 0) DESC, COALESCE("downloadCountDay", 0) DESC, "userId") AS "ratingCountRankDay",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingDay", 0) DESC, COALESCE("ratingCountDay", 0) DESC, COALESCE("favoriteCountDay", 0) DESC, COALESCE("downloadCountDay", 0) DESC, "userId") AS "ratingRankDay",
	ROW_NUMBER() OVER (ORDER BY COALESCE("followerCountDay", 0) DESC, COALESCE("downloadCountDay", 0) DESC, COALESCE("favoriteCountDay", 0) DESC, COALESCE("ratingCountDay", 0) DESC, "userId") AS "followerCountRankDay",
	ROW_NUMBER() OVER (ORDER BY COALESCE("downloadCountWeek", 0) DESC, COALESCE("ratingWeek", 0) DESC, COALESCE("ratingCountWeek", 0) DESC, COALESCE("favoriteCountWeek", 0) DESC, "userId") AS "downloadCountRankWeek",
	ROW_NUMBER() OVER (ORDER BY COALESCE("favoriteCountWeek", 0) DESC, COALESCE("ratingWeek", 0) DESC, COALESCE("ratingCountWeek", 0) DESC, COALESCE("downloadCountWeek", 0) DESC, "userId") AS "favoriteCountRankWeek",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingCountWeek", 0) DESC, COALESCE("ratingWeek", 0) DESC, COALESCE("favoriteCountWeek", 0) DESC, COALESCE("downloadCountWeek", 0) DESC, "userId") AS "ratingCountRankWeek",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingWeek", 0) DESC, COALESCE("ratingCountWeek", 0) DESC, COALESCE("favoriteCountWeek", 0) DESC, COALESCE("downloadCountWeek", 0) DESC, "userId") AS "ratingRankWeek",
	ROW_NUMBER() OVER (ORDER BY COALESCE("followerCountWeek", 0) DESC, COALESCE("downloadCountWeek", 0) DESC, COALESCE("favoriteCountWeek", 0) DESC, COALESCE("ratingCountWeek", 0) DESC, "userId") AS "followerCountRankWeek",
	ROW_NUMBER() OVER (ORDER BY COALESCE("downloadCountMonth", 0) DESC, COALESCE("ratingMonth", 0) DESC, COALESCE("ratingCountMonth", 0) DESC, COALESCE("favoriteCountMonth", 0) DESC, "userId") AS "downloadCountRankMonth",
	ROW_NUMBER() OVER (ORDER BY COALESCE("favoriteCountMonth", 0) DESC, COALESCE("ratingMonth", 0) DESC, COALESCE("ratingCountMonth", 0) DESC, COALESCE("downloadCountMonth", 0) DESC, "userId") AS "favoriteCountRankMonth",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingCountMonth", 0) DESC, COALESCE("ratingMonth", 0) DESC, COALESCE("favoriteCountMonth", 0) DESC, COALESCE("downloadCountMonth", 0) DESC, "userId") AS "ratingCountRankMonth",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingMonth", 0) DESC, COALESCE("ratingCountMonth", 0) DESC, COALESCE("favoriteCountMonth", 0) DESC, COALESCE("downloadCountMonth", 0) DESC, "userId") AS "ratingRankMonth",
	ROW_NUMBER() OVER (ORDER BY COALESCE("followerCountMonth", 0) DESC, COALESCE("downloadCountMonth", 0) DESC, COALESCE("favoriteCountMonth", 0) DESC, COALESCE("ratingCountMonth", 0) DESC, "userId") AS "followerCountRankMonth",
	ROW_NUMBER() OVER (ORDER BY COALESCE("downloadCountYear", 0) DESC, COALESCE("ratingYear", 0) DESC, COALESCE("ratingCountYear", 0) DESC, COALESCE("favoriteCountYear", 0) DESC, "userId") AS "downloadCountRankYear",
	ROW_NUMBER() OVER (ORDER BY COALESCE("favoriteCountYear", 0) DESC, COALESCE("ratingYear", 0) DESC, COALESCE("ratingCountYear", 0) DESC, COALESCE("downloadCountYear", 0) DESC, "userId") AS "favoriteCountRankYear",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingCountYear", 0) DESC, COALESCE("ratingYear", 0) DESC, COALESCE("favoriteCountYear", 0) DESC, COALESCE("downloadCountYear", 0) DESC, "userId") AS "ratingCountRankYear",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingYear", 0) DESC, COALESCE("ratingCountYear", 0) DESC, COALESCE("favoriteCountYear", 0) DESC, COALESCE("downloadCountYear", 0) DESC, "userId") AS "ratingRankYear",
	ROW_NUMBER() OVER (ORDER BY COALESCE("followerCountYear", 0) DESC, COALESCE("downloadCountYear", 0) DESC, COALESCE("favoriteCountYear", 0) DESC, COALESCE("ratingCountYear", 0) DESC, "userId") AS "followerCountRankYear",
	ROW_NUMBER() OVER (ORDER BY COALESCE("downloadCountAllTime", 0) DESC, COALESCE("ratingAllTime", 0) DESC, COALESCE("ratingCountAllTime", 0) DESC, COALESCE("favoriteCountAllTime", 0) DESC, "userId") AS "downloadCountRankAllTime",
	ROW_NUMBER() OVER (ORDER BY COALESCE("favoriteCountAllTime", 0) DESC, COALESCE("ratingAllTime", 0) DESC, COALESCE("ratingCountAllTime", 0) DESC, COALESCE("downloadCountAllTime", 0) DESC, "userId") AS "favoriteCountRankAllTime",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingCountAllTime", 0) DESC, COALESCE("ratingAllTime", 0) DESC, COALESCE("favoriteCountAllTime", 0) DESC, COALESCE("downloadCountAllTime", 0) DESC, "userId") AS "ratingCountRankAllTime",
	ROW_NUMBER() OVER (ORDER BY COALESCE("ratingAllTime", 0) DESC, COALESCE("ratingCountAllTime", 0) DESC, COALESCE("favoriteCountAllTime", 0) DESC, COALESCE("downloadCountAllTime", 0) DESC, "userId") AS "ratingRankAllTime",
	ROW_NUMBER() OVER (ORDER BY COALESCE("followerCountAllTime", 0) DESC, COALESCE("downloadCountAllTime", 0) DESC, COALESCE("favoriteCountAllTime", 0) DESC, COALESCE("ratingCountAllTime", 0) DESC, "userId") AS "followerCountRankAllTime"
FROM "UserStat";

CREATE UNIQUE INDEX urank_user_id ON "UserRank" ("userId");