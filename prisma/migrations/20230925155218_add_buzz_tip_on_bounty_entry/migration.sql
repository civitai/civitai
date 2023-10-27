-- AlterTable
ALTER TABLE "BountyEntryMetric" ADD COLUMN     "tippedAmountCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tippedCount" INTEGER NOT NULL DEFAULT 0;

-- Bounty Entry Stats View
DROP VIEW IF EXISTS "BountyEntryStat";
CREATE VIEW "BountyEntryStat" AS
WITH stats_timeframe AS (
  SELECT
m."bountyEntryId",
  m.timeframe,
  COALESCE(m."heartCount", 0) AS "heartCount",
  COALESCE(m."likeCount", 0) AS "likeCount",
  COALESCE(m."dislikeCount", 0) AS "dislikeCount",
  COALESCE(m."laughCount", 0) AS "laughCount",
  COALESCE(m."cryCount", 0) AS "cryCount",
  COALESCE(m."heartCount", 0) + COALESCE(m."likeCount", 0) + COALESCE(m."dislikeCount", 0) + COALESCE(m."laughCount", 0) + COALESCE(m."cryCount", 0) AS "reactionCount",
  COALESCE(m."unitAmountCount", 0) AS "unitAmountCount",
  COALESCE(m."tippedCount", 0) AS "tippedCount",
  COALESCE(m."tippedAmountCount", 0) AS "tippedAmountCount"
FROM "BountyEntryMetric" m
GROUP BY m."bountyEntryId", m.timeframe
)
SELECT
"bountyEntryId",
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
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountAllTime",
	MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
	MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
	MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
	MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
	MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime"
from stats_timeframe
GROUP BY "bountyEntryId";

-- Bounty Rank View
drop view if exists "BountyEntryRank_Live";
create or replace view "BountyEntryRank_Live" as
  WITH timeframe_stats AS (
  SELECT
m."bountyEntryId",
  m."heartCount",
  m."likeCount",
  m."dislikeCount",
  m."laughCount",
  m."cryCount",
  m."heartCount" + m."likeCount" + m."dislikeCount" + m."laughCount" +
m."cryCount" AS "reactionCount",
  m."unitAmountCount",
  m."tippedCount",
  m."tippedAmountCount",
  m.timeframe
FROM "BountyEntryMetric" m
), timeframe_rank AS (
  SELECT
"bountyEntryId",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "heartCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "likeCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "dislikeCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "laughCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "cryCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, "bountyEntryId" DESC) AS "reactionCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("unitAmountCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "bountyEntryId" DESC) AS "unitAmountCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("tippedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "bountyEntryId" DESC) AS "tippedCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("tippedAmountCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "bountyEntryId" DESC) AS "tippedAmountCountRank",
  timeframe
FROM timeframe_stats
)
SELECT
"bountyEntryId",
  MAX(iif(timeframe = 'Day', "heartCountRank", NULL)) AS "heartCountDayRank",
  MAX(iif(timeframe = 'Week', "heartCountRank", NULL)) AS "heartCountWeekRank",
  MAX(iif(timeframe = 'Month', "heartCountRank", NULL)) AS "heartCountMonthRank",
  MAX(iif(timeframe = 'Year', "heartCountRank", NULL)) AS "heartCountYearRank",
  MAX(iif(timeframe = 'AllTime', "heartCountRank", NULL)) AS "heartCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "likeCountRank", NULL)) AS "likeCountDayRank",
  MAX(iif(timeframe = 'Week', "likeCountRank", NULL)) AS "likeCountWeekRank",
  MAX(iif(timeframe = 'Month', "likeCountRank", NULL)) AS "likeCountMonthRank",
  MAX(iif(timeframe = 'Year', "likeCountRank", NULL)) AS "likeCountYearRank",
  MAX(iif(timeframe = 'AllTime', "likeCountRank", NULL)) AS "likeCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "dislikeCountRank", NULL)) AS "dislikeCountDayRank",
  MAX(iif(timeframe = 'Week', "dislikeCountRank", NULL)) AS "dislikeCountWeekRank",
  MAX(iif(timeframe = 'Month', "dislikeCountRank", NULL)) AS "dislikeCountMonthRank",
  MAX(iif(timeframe = 'Year', "dislikeCountRank", NULL)) AS "dislikeCountYearRank",
  MAX(iif(timeframe = 'AllTime', "dislikeCountRank", NULL)) AS "dislikeCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "laughCountRank", NULL)) AS "laughCountDayRank",
  MAX(iif(timeframe = 'Week', "laughCountRank", NULL)) AS "laughCountWeekRank",
  MAX(iif(timeframe = 'Month', "laughCountRank", NULL)) AS "laughCountMonthRank",
  MAX(iif(timeframe = 'Year', "laughCountRank", NULL)) AS "laughCountYearRank",
  MAX(iif(timeframe = 'AllTime', "laughCountRank", NULL)) AS "laughCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "cryCountRank", NULL)) AS "cryCountDayRank",
  MAX(iif(timeframe = 'Week', "cryCountRank", NULL)) AS "cryCountWeekRank",
  MAX(iif(timeframe = 'Month', "cryCountRank", NULL)) AS "cryCountMonthRank",
  MAX(iif(timeframe = 'Year', "cryCountRank", NULL)) AS "cryCountYearRank",
  MAX(iif(timeframe = 'AllTime', "cryCountRank", NULL)) AS "cryCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "reactionCountRank", NULL)) AS "reactionCountDayRank",
  MAX(iif(timeframe = 'Week', "reactionCountRank", NULL)) AS "reactionCountWeekRank",
  MAX(iif(timeframe = 'Month', "reactionCountRank", NULL)) AS "reactionCountMonthRank",
  MAX(iif(timeframe = 'Year', "reactionCountRank", NULL)) AS "reactionCountYearRank",
  MAX(iif(timeframe = 'AllTime', "reactionCountRank", NULL)) AS "reactionCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "unitAmountCountRank", NULL)) AS "unitAmountCountDayRank",
  MAX(iif(timeframe = 'Week', "unitAmountCountRank", NULL)) AS "unitAmountCountWeekRank",
  MAX(iif(timeframe = 'Month', "unitAmountCountRank", NULL)) AS "unitAmountCountMonthRank",
  MAX(iif(timeframe = 'Year', "unitAmountCountRank", NULL)) AS "unitAmountCountYearRank",
  MAX(iif(timeframe = 'AllTime', "unitAmountCountRank", NULL)) AS "unitAmountCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "tippedCountRank", NULL)) AS "tippedCountDayRank",
	MAX(iif(timeframe = 'Week', "tippedCountRank", NULL)) AS "tippedCountWeekRank",
	MAX(iif(timeframe = 'Month', "tippedCountRank", NULL)) AS "tippedCountMonthRank",
	MAX(iif(timeframe = 'Year', "tippedCountRank", NULL)) AS "tippedCountYearRank",
	MAX(iif(timeframe = 'AllTime', "tippedCountRank", NULL)) AS "tippedCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "tippedAmountCountRank", NULL)) AS "tippedAmountCountDayRank",
	MAX(iif(timeframe = 'Week', "tippedAmountCountRank", NULL)) AS "tippedAmountCountWeekRank",
	MAX(iif(timeframe = 'Month', "tippedAmountCountRank", NULL)) AS "tippedAmountCountMonthRank",
	MAX(iif(timeframe = 'Year', "tippedAmountCountRank", NULL)) AS "tippedAmountCountYearRank",
	MAX(iif(timeframe = 'AllTime', "tippedAmountCountRank", NULL)) AS "tippedAmountCountAllTimeRank"
FROM timeframe_rank
GROUP BY "bountyEntryId";
