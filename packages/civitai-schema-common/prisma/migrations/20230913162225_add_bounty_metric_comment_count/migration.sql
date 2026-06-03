ALTER TABLE "BountyMetric" ADD COLUMN     "commentCount" INTEGER NOT NULL DEFAULT 0;

-- Bounty Stats View
DROP VIEW IF EXISTS "BountyStat";
CREATE VIEW "BountyStat" AS
WITH stats_timeframe AS (
  SELECT
m."bountyId",
  m.timeframe,
  coalesce(m."favoriteCount", 0) AS "favoriteCount",
  coalesce(m."trackCount", 0) AS "trackCount",
  coalesce(m."entryCount", 0) AS "entryCount",
  coalesce(m."benefactorCount", 0) AS "benefactorCount",
  coalesce(m."unitAmountCount", 0) AS "unitAmountCount",
  coalesce(m."commentCount", 0) AS "commentCount"
FROM "BountyMetric" m
GROUP BY m."bountyId", m.timeframe
)
SELECT
"bountyId",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountAllTime",
  MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL)) AS "commentCountDay",
  MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL)) AS "commentCountWeek",
  MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL)) AS "commentCountMonth",
  MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL)) AS "commentCountYear",
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL)) AS "commentCountAllTime"
from stats_timeframe
GROUP BY "bountyId";

-- Bounty Rank View
drop view if exists "BountyRank_Live";
create or replace view "BountyRank_Live" as
  WITH timeframe_stats AS (
  SELECT
m."bountyId",
  m."favoriteCount",
  m."trackCount",
  m."entryCount",
  m."benefactorCount",
  m."unitAmountCount",
  m."commentCount",
  m."favoriteCount" + m."trackCount" + m."entryCount" + m."benefactorCount" AS "engagementCount",
  m.timeframe
FROM "BountyMetric" m
), timeframe_rank AS (
  SELECT
"bountyId",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("favoriteCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "favoriteCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("trackCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "trackCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("entryCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "entryCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("benefactorCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "benefactorCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("unitAmountCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "unitAmountCountRank",
  ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("engagementCount", 0)) DESC, "bountyId" DESC) AS "commentCountRank",
  timeframe
FROM timeframe_stats
)
SELECT
"bountyId",
  MAX(iif(timeframe = 'Day', "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
  MAX(iif(timeframe = 'Week', "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
  MAX(iif(timeframe = 'Month', "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
  MAX(iif(timeframe = 'Year', "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
  MAX(iif(timeframe = 'AllTime', "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "trackCountRank", NULL)) AS "trackCountDayRank",
  MAX(iif(timeframe = 'Week', "trackCountRank", NULL)) AS "trackCountWeekRank",
  MAX(iif(timeframe = 'Month', "trackCountRank", NULL)) AS "trackCountMonthRank",
  MAX(iif(timeframe = 'Year', "trackCountRank", NULL)) AS "trackCountYearRank",
  MAX(iif(timeframe = 'AllTime', "trackCountRank", NULL)) AS "trackCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "entryCountRank", NULL)) AS "entryCountDayRank",
  MAX(iif(timeframe = 'Week', "entryCountRank", NULL)) AS "entryCountWeekRank",
  MAX(iif(timeframe = 'Month', "entryCountRank", NULL)) AS "entryCountMonthRank",
  MAX(iif(timeframe = 'Year', "entryCountRank", NULL)) AS "entryCountYearRank",
  MAX(iif(timeframe = 'AllTime', "entryCountRank", NULL)) AS "entryCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "benefactorCountRank", NULL)) AS "benefactorCountDayRank",
  MAX(iif(timeframe = 'Week', "benefactorCountRank", NULL)) AS "benefactorCountWeekRank",
  MAX(iif(timeframe = 'Month', "benefactorCountRank", NULL)) AS "benefactorCountMonthRank",
  MAX(iif(timeframe = 'Year', "benefactorCountRank", NULL)) AS "benefactorCountYearRank",
  MAX(iif(timeframe = 'AllTime', "benefactorCountRank", NULL)) AS "benefactorCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "unitAmountCountRank", NULL)) AS "unitAmountCountDayRank",
  MAX(iif(timeframe = 'Week', "unitAmountCountRank", NULL)) AS "unitAmountCountWeekRank",
  MAX(iif(timeframe = 'Month', "unitAmountCountRank", NULL)) AS "unitAmountCountMonthRank",
  MAX(iif(timeframe = 'Year', "unitAmountCountRank", NULL)) AS "unitAmountCountYearRank",
  MAX(iif(timeframe = 'AllTime', "unitAmountCountRank", NULL)) AS "unitAmountCountAllTimeRank",
  MAX(iif(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
  MAX(iif(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
  MAX(iif(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
  MAX(iif(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
  MAX(iif(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank"
FROM timeframe_rank
GROUP BY "bountyId";

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
  COALESCE(m."unitAmountCount", 0) AS "unitAmountCount"
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
  MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountAllTime"
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
  MAX(iif(timeframe = 'AllTime', "unitAmountCountRank", NULL)) AS "unitAmountCountAllTimeRank"
FROM timeframe_rank
GROUP BY "bountyEntryId";
