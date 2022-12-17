-- CreateEnum
CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide');

-- CreateTable
CREATE TABLE "UserEngagement" (
    "userId" INTEGER NOT NULL,
    "targetUserId" INTEGER NOT NULL,
    "type" "UserEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEngagement_pkey" PRIMARY KEY ("userId","targetUserId")
);

-- CreateTable
CREATE TABLE "UserMetric" (
    "userId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "hiddenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserMetric_pkey" PRIMARY KEY ("userId","timeframe")
);

-- AddForeignKey
ALTER TABLE "UserEngagement" ADD CONSTRAINT "UserEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEngagement" ADD CONSTRAINT "UserEngagement_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMetric" ADD CONSTRAINT "UserMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Update UserRank view
DROP View "UserRank";
CREATE OR REPLACE VIEW "UserRank" AS
SELECT
	"userId",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCount", NULL::bigint)) AS "followerCountDay",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "rating", NULL::float)) AS "ratingDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCount", NULL::bigint)) AS "followerCountWeek",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "rating", NULL::float)) AS "ratingWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCount", NULL::bigint)) AS "followerCountMonth",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "rating", NULL::float)) AS "ratingMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCount", NULL::bigint)) AS "followerCountYear",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "rating", NULL::float)) AS "ratingYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCount", NULL::bigint)) AS "downloadCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCount", NULL::bigint)) AS "ratingCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL::bigint)) AS "favoriteCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCount", NULL::bigint)) AS "followerCountAllTime",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "rating", NULL::float)) AS "ratingAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "followerCountRank", NULL::bigint)) AS "followerCountDayRank",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingDayRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "followerCountRank", NULL::bigint)) AS "followerCountWeekRank",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingWeekRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "followerCountRank", NULL::bigint)) AS "followerCountMonthRank",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingMonthRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "followerCountRank", NULL::bigint)) AS "followerCountYearRank",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingYearRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "downloadCountRank", NULL::bigint)) AS "downloadCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingCountRank", NULL::bigint)) AS "ratingCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCountRank", NULL::bigint)) AS "favoriteCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "followerCountRank", NULL::bigint)) AS "followerCountAllTimeRank",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "ratingRank", NULL::bigint)) AS "ratingAllTimeRank"
FROM (
	SELECT
	    u.*,
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("downloadCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, "userId") AS "downloadCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("favoriteCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "favoriteCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("ratingCount", 0) DESC, COALESCE(rating, 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingCountRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE(rating, 0) DESC, COALESCE("ratingCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("downloadCount", 0) DESC, "userId") AS "ratingRank",
	    ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY COALESCE("followerCount", 0) DESC, COALESCE("downloadCount", 0) DESC, COALESCE("favoriteCount", 0) DESC, COALESCE("ratingCount", 0) DESC, "userId") AS "followerCountRank"
	FROM (
		SELECT
		    u.id as "userId",
		    tf.timeframe,
		    coalesce(sum("downloadCount"), 0) AS "downloadCount",
		    coalesce(sum("favoriteCount"), 0) AS "favoriteCount",
		    coalesce(sum("ratingCount"), 0) AS "ratingCount",
		    coalesce(sum(um."followingCount"), 0) AS "followingCount",
		    coalesce(sum(um."followerCount"), 0) AS "followerCount",
		    coalesce(sum(um."hiddenCount"), 0) AS "hiddenCount",
		    IIF(sum("ratingCount") IS NULL OR sum("ratingCount") < 1, 0::double precision, sum("rating" * "ratingCount")/sum("ratingCount")) AS "rating"
		FROM "User" u
		CROSS JOIN (
			SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
		) tf
		LEFT JOIN "UserMetric" um ON um."userId" = u.id AND um.timeframe = tf.timeframe
		LEFT JOIN (
			SELECT
				m."userId",
				m.id AS "modelId",
				COALESCE(mm."downloadCount", 0) AS "downloadCount",
				COALESCE(mm."favoriteCount", 0) AS "favoriteCount",
				COALESCE(mm."ratingCount", 0) AS "ratingCount",
				COALESCE(mm."rating", 0) AS "rating",
				tf.timeframe
			FROM "Model" m
			CROSS JOIN (
				SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
			) tf
			LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = tf.timeframe
		) m ON m."userId" = u.id AND tf.timeframe = m.timeframe
		GROUP BY u.id, tf.timeframe
	) u
) t
GROUP BY "userId";