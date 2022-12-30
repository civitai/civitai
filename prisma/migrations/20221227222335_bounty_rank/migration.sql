/*
  Warnings:

  - You are about to drop the column `hunterBountyId` on the `HunterMetric` table. All the data in the column will be lost.
  - You are about to drop the column `hunterUserId` on the `HunterMetric` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "HunterMetric" DROP CONSTRAINT "HunterMetric_hunterBountyId_hunterUserId_fkey";

-- AlterTable
ALTER TABLE "HunterMetric" DROP COLUMN "hunterBountyId",
DROP COLUMN "hunterUserId";

-- AddForeignKey
ALTER TABLE "HunterMetric" ADD CONSTRAINT "HunterMetric_hunterId_fkey" FOREIGN KEY ("hunterId") REFERENCES "Hunter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Views
CREATE VIEW "BountyRank" AS
WITH timeframe_stats AS (
  SELECT
		b.id AS "bountyId",
		COALESCE(bm."hunterCount", 0) AS "hunterCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(bm."hunterCount", 0) DESC, COALESCE(bm."bountyValue", 0) DESC, COALESCE(bm."favoriteCount", 0) DESC, b.Id DESC) AS "hunterCountRank",
		COALESCE(bm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(bm."commentCount", 0) DESC, COALESCE(bm."bountyValue", 0) DESC, COALESCE(bm."favoriteCount", 0) DESC, b.Id DESC) AS "commentCountRank",
		COALESCE(bm."benefactorCount", 0) AS "benefactorCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(bm."benefactorCount", 0) DESC, COALESCE(bm."bountyValue", 0) DESC, COALESCE(bm."favoriteCount", 0) DESC, b.Id DESC) AS "benefactorCountRank",
		COALESCE(bm."bountyValue", 0) AS "bountyValue",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(bm."bountyValue", 0) DESC, COALESCE(bm."favoriteCount", 0) DESC, COALESCE(bm."hunterCount", 0) DESC, b.Id DESC) AS "bountyValueRank",
    COALESCE(bm."favoriteCount", 0) AS "favoriteCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(bm."favoriteCount", 0) DESC, COALESCE(bm."bountyValue", 0) DESC, COALESCE(bm."hunterCount", 0) DESC, b.Id DESC) AS "favoriteCountRank",
		tf.timeframe
	FROM "Bounty" b
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "BountyMetric" bm ON bm."bountyId" = b.id AND bm.timeframe = tf.timeframe
), stats AS (
  SELECT
		"bountyId",
		MAX(IIF(timeframe = 'Day', "favoriteCount", NULL)) AS "favoriteCountDay",
		MAX(IIF(timeframe = 'Day', "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
		MAX(IIF(timeframe = 'Week', "favoriteCount", NULL)) AS "favoriteCountWeek",
		MAX(IIF(timeframe = 'Week', "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
		MAX(IIF(timeframe = 'Month', "favoriteCount", NULL)) AS "favoriteCountMonth",
		MAX(IIF(timeframe = 'Month', "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
		MAX(IIF(timeframe = 'Year', "favoriteCount", NULL)) AS "favoriteCountYear",
		MAX(IIF(timeframe = 'Year', "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "favoriteCount", NULL)) AS "favoriteCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
		MAX(IIF(timeframe = 'Day', "commentCount", NULL)) AS "commentCountDay",
		MAX(IIF(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
		MAX(IIF(timeframe = 'Week', "commentCount", NULL)) AS "commentCountWeek",
		MAX(IIF(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
		MAX(IIF(timeframe = 'Month', "commentCount", NULL)) AS "commentCountMonth",
		MAX(IIF(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
		MAX(IIF(timeframe = 'Year', "commentCount", NULL)) AS "commentCountYear",
		MAX(IIF(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "commentCount", NULL)) AS "commentCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank",
		MAX(IIF(timeframe = 'Day', "hunterCount", NULL)) AS "hunterCountDay",
		MAX(IIF(timeframe = 'Day', "hunterCountRank", NULL)) AS "hunterCountDayRank",
		MAX(IIF(timeframe = 'Week', "hunterCount", NULL)) AS "hunterCountWeek",
		MAX(IIF(timeframe = 'Week', "hunterCountRank", NULL)) AS "hunterCountWeekRank",
		MAX(IIF(timeframe = 'Month', "hunterCount", NULL)) AS "hunterCountMonth",
		MAX(IIF(timeframe = 'Month', "hunterCountRank", NULL)) AS "hunterCountMonthRank",
		MAX(IIF(timeframe = 'Year', "hunterCount", NULL)) AS "hunterCountYear",
		MAX(IIF(timeframe = 'Year', "hunterCountRank", NULL)) AS "hunterCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "hunterCount", NULL)) AS "hunterCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "hunterCountRank", NULL)) AS "hunterCountAllTimeRank",
		MAX(IIF(timeframe = 'Day', "benefactorCount", NULL)) AS "benefactorCountDay",
		MAX(IIF(timeframe = 'Day', "benefactorCountRank", NULL)) AS "benefactorCountDayRank",
		MAX(IIF(timeframe = 'Week', "benefactorCount", NULL)) AS "benefactorCountWeek",
		MAX(IIF(timeframe = 'Week', "benefactorCountRank", NULL)) AS "benefactorCountWeekRank",
		MAX(IIF(timeframe = 'Month', "benefactorCount", NULL)) AS "benefactorCountMonth",
		MAX(IIF(timeframe = 'Month', "benefactorCountRank", NULL)) AS "benefactorCountMonthRank",
		MAX(IIF(timeframe = 'Year', "benefactorCount", NULL)) AS "benefactorCountYear",
		MAX(IIF(timeframe = 'Year', "benefactorCountRank", NULL)) AS "benefactorCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "benefactorCount", NULL)) AS "benefactorCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "benefactorCountRank", NULL)) AS "benefactorCountAllTimeRank",
		MAX(IIF(timeframe = 'Day', "bountyValue", NULL)) AS "bountyValueDay",
		MAX(IIF(timeframe = 'Day', "bountyValueRank", NULL)) AS "bountyValueDayRank",
		MAX(IIF(timeframe = 'Week', "bountyValue", NULL)) AS "bountyValueWeek",
		MAX(IIF(timeframe = 'Week', "bountyValueRank", NULL)) AS "bountyValueWeekRank",
		MAX(IIF(timeframe = 'Month', "bountyValue", NULL)) AS "bountyValueMonth",
		MAX(IIF(timeframe = 'Month', "bountyValueRank", NULL)) AS "bountyValueMonthRank",
		MAX(IIF(timeframe = 'Year', "bountyValue", NULL)) AS "bountyValueYear",
		MAX(IIF(timeframe = 'Year', "bountyValueRank", NULL)) AS "bountyValueYearRank",
		MAX(IIF(timeframe = 'AllTime', "bountyValue", NULL)) AS "bountyValueAllTime",
		MAX(IIF(timeframe = 'AllTime', "bountyValueRank", NULL)) AS "bountyValueAllTimeRank"
  FROM timeframe_stats
  GROUP BY "bountyId"
)
SELECT
  *
FROM stats;

CREATE VIEW "HunterRank" AS
WITH timeframe_stats AS (
  SELECT
		h.id AS "hunterId",
		COALESCE(hm."commentCount", 0) AS "commentCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(hm."commentCount", 0) DESC, COALESCE(hm."favoriteCount", 0) DESC, h.Id DESC) AS "commentCountRank",
    COALESCE(hm."favoriteCount", 0) AS "favoriteCount",
		ROW_NUMBER() OVER (PARTITION BY tf.timeframe ORDER BY COALESCE(hm."favoriteCount", 0) DESC, COALESCE(hm."commentCount", 0) DESC, h.Id DESC) AS "favoriteCountRank",
		tf.timeframe
	FROM "Hunter" h
	CROSS JOIN (
		SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
	) tf
	LEFT JOIN "HunterMetric" hm ON hm."hunterId" = h.id AND hm.timeframe = tf.timeframe
), stats AS (
  SELECT
		"hunterId",
		MAX(IIF(timeframe = 'Day', "favoriteCount", NULL)) AS "favoriteCountDay",
		MAX(IIF(timeframe = 'Day', "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
		MAX(IIF(timeframe = 'Week', "favoriteCount", NULL)) AS "favoriteCountWeek",
		MAX(IIF(timeframe = 'Week', "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
		MAX(IIF(timeframe = 'Month', "favoriteCount", NULL)) AS "favoriteCountMonth",
		MAX(IIF(timeframe = 'Month', "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
		MAX(IIF(timeframe = 'Year', "favoriteCount", NULL)) AS "favoriteCountYear",
		MAX(IIF(timeframe = 'Year', "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "favoriteCount", NULL)) AS "favoriteCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
		MAX(IIF(timeframe = 'Day', "commentCount", NULL)) AS "commentCountDay",
		MAX(IIF(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
		MAX(IIF(timeframe = 'Week', "commentCount", NULL)) AS "commentCountWeek",
		MAX(IIF(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
		MAX(IIF(timeframe = 'Month', "commentCount", NULL)) AS "commentCountMonth",
		MAX(IIF(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
		MAX(IIF(timeframe = 'Year', "commentCount", NULL)) AS "commentCountYear",
		MAX(IIF(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
		MAX(IIF(timeframe = 'AllTime', "commentCount", NULL)) AS "commentCountAllTime",
		MAX(IIF(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank"
  FROM timeframe_stats
  GROUP BY "hunterId"
)
SELECT
  *
FROM stats;