-- Bounty Stats View
DROP TABLE IF EXISTS "BountyStat" CASCADE;
---
DROP VIEW IF EXISTS "BountyStat" CASCADE;
---
CREATE VIEW "BountyStat" AS
WITH stats_timeframe AS (
	SELECT
	  m."bountyId",
	  m.timeframe,
	  coalesce(m."favoriteCount", 0) AS "favoriteCount",
	  coalesce(m."trackCount", 0) AS "trackCount",
	  coalesce(m."entryCount", 0) AS "entryCount",
	  coalesce(m."benefactorCount", 0) AS "benefactorCount",
	  coalesce(m."unitAmountCount", 0) AS "unitAmountCount"
	FROM "BountyMetric" m
	GROUP BY m."bountyId", m.timeframe
)
SELECT
"bountyId",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL)) AS "favoriteCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "trackCount", NULL)) AS "trackCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "entryCount", NULL)) AS "entryCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "benefactorCount", NULL)) AS "benefactorCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountAllTime"
from stats_timeframe
GROUP BY "bountyId";
---
-- Bounty Rank View
DROP VIEW IF EXISTS "BountyRank_Live" CASCADE;
---
CREATE VIEW "BountyRank_Live" as
WITH timeframe_stats AS (
	SELECT
		m."bountyId",
		m."favoriteCount",
		m."trackCount",
		m."entryCount",
		m."benefactorCount",
		m."unitAmountCount",
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
	MAX(iif(timeframe = 'AllTime', "unitAmountCountRank", NULL)) AS "unitAmountCountAllTimeRank"
FROM timeframe_rank
GROUP BY "bountyId";
---
-- Bounty Entry Stats View
DROP TABLE IF EXISTS "BountyEntryStat" CASCADE;
---
DROP VIEW IF EXISTS "BountyEntryStat" CASCADE;
---
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
	  coalesce(m."unitAmountCount", 0) AS "unitAmountCount"
	FROM "BountyEntryMetric" m
	GROUP BY m."bountyEntryId", m.timeframe
)
SELECT
"bountyEntryId",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "unitAmountCount", NULL)) AS "unitAmountCountAllTime"
from stats_timeframe
GROUP BY "bountyEntryId";
---
-- Bounty Entry Rank View
DROP VIEW IF EXISTS "BountyEntryRank_Live" CASCADE;
---
CREATE VIEW "BountyEntryRank_Live" as
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
---
-- Article Stats View
DROP TABLE IF EXISTS "ArticleStat" CASCADE;
---
DROP VIEW IF EXISTS "ArticleStat" CASCADE;
---
CREATE VIEW "ArticleStat" AS
WITH timeframe_stats AS (
  SELECT
		m."articleId",
        COALESCE(m."heartCount", 0) AS "heartCount",
        COALESCE(m."likeCount", 0) AS "likeCount",
        COALESCE(m."dislikeCount", 0) AS "dislikeCount",
        COALESCE(m."laughCount", 0) AS "laughCount",
        COALESCE(m."cryCount", 0) AS "cryCount",
        COALESCE(m."commentCount", 0) AS "commentCount",
        COALESCE(m."viewCount", 0) AS "viewCount",
        COALESCE(m."favoriteCount", 0) AS "favoriteCount",
        COALESCE(m."hideCount", 0) AS "hideCount",
        COALESCE(m."tippedCount", 0) AS "tippedCount",
        COALESCE(m."tippedAmountCount", 0) AS "tippedAmountCount",
		m.timeframe
	FROM "ArticleMetric" m
)
SELECT
	"articleId",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCount", NULL::integer)) AS "heartCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "likeCount", NULL::integer)) AS "likeCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCount", NULL::integer)) AS "dislikeCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "laughCount", NULL::integer)) AS "laughCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "cryCount", NULL::integer)) AS "cryCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "commentCount", NULL::integer)) AS "commentCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCount" + "dislikeCount" + "likeCount" + "cryCount" + "laughCount", NULL::integer)) AS "reactionCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "viewCount", NULL::integer)) AS "viewCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "favoriteCount", NULL::integer)) AS "favoriteCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "favoriteCount", NULL::integer)) AS "favoriteCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "favoriteCount", NULL::integer)) AS "favoriteCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "favoriteCount", NULL::integer)) AS "favoriteCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "favoriteCount", NULL::integer)) AS "favoriteCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "hideCount", NULL::integer)) AS "hideCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "hideCount", NULL::integer)) AS "hideCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "hideCount", NULL::integer)) AS "hideCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "hideCount", NULL::integer)) AS "hideCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "hideCount", NULL::integer)) AS "hideCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "tippedCount", NULL::integer)) AS "tippedCountAllTime",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountDay",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountWeek",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountMonth",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountYear",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "tippedAmountCount", NULL::integer)) AS "tippedAmountCountAllTime"
FROM timeframe_stats ts
GROUP BY "articleId";
---
-- Article Rank View
DROP VIEW IF EXISTS "ArticleRank_Live" CASCADE;
---
CREATE VIEW "ArticleRank_Live" AS
WITH timeframe_stats AS (
	SELECT
		m."articleId",
		m."heartCount",
		m."likeCount",
		m."dislikeCount",
		m."laughCount",
		m."cryCount",
		m."commentCount",
		m."heartCount" + m."likeCount" + m."dislikeCount" + m."laughCount" +
		m."cryCount" AS "reactionCount",
		m."viewCount",
		m."favoriteCount",
		m."hideCount",
		m."collectedCount",
		m."tippedCount",
		m."tippedAmountCount",
		m.timeframe
	FROM "ArticleMetric" m
), timeframe_rank AS (
	SELECT
		"articleId",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "articleId" DESC) AS "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "articleId" DESC) AS "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "articleId" DESC) AS "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "commentCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("viewCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "viewCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("favoriteCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "favoriteCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("hideCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "hideCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("collectedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "collectedCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("tippedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "tippedCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("tippedAmountCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "articleId" DESC) AS "tippedAmountCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"articleId",
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
	MAX(iif(timeframe = 'Day', "commentCountRank", NULL)) AS "commentCountDayRank",
	MAX(iif(timeframe = 'Week', "commentCountRank", NULL)) AS "commentCountWeekRank",
	MAX(iif(timeframe = 'Month', "commentCountRank", NULL)) AS "commentCountMonthRank",
	MAX(iif(timeframe = 'Year', "commentCountRank", NULL)) AS "commentCountYearRank",
	MAX(iif(timeframe = 'AllTime', "commentCountRank", NULL)) AS "commentCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "viewCountRank", NULL)) AS "viewCountDayRank",
	MAX(iif(timeframe = 'Week', "viewCountRank", NULL)) AS "viewCountWeekRank",
	MAX(iif(timeframe = 'Month', "viewCountRank", NULL)) AS "viewCountMonthRank",
	MAX(iif(timeframe = 'Year', "viewCountRank", NULL)) AS "viewCountYearRank",
	MAX(iif(timeframe = 'AllTime', "viewCountRank", NULL)) AS "viewCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "favoriteCountRank", NULL)) AS "favoriteCountDayRank",
	MAX(iif(timeframe = 'Week', "favoriteCountRank", NULL)) AS "favoriteCountWeekRank",
	MAX(iif(timeframe = 'Month', "favoriteCountRank", NULL)) AS "favoriteCountMonthRank",
	MAX(iif(timeframe = 'Year', "favoriteCountRank", NULL)) AS "favoriteCountYearRank",
	MAX(iif(timeframe = 'AllTime', "favoriteCountRank", NULL)) AS "favoriteCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "hideCountRank", NULL)) AS "hideCountDayRank",
	MAX(iif(timeframe = 'Week', "hideCountRank", NULL)) AS "hideCountWeekRank",
	MAX(iif(timeframe = 'Month', "hideCountRank", NULL)) AS "hideCountMonthRank",
	MAX(iif(timeframe = 'Year', "hideCountRank", NULL)) AS "hideCountYearRank",
	MAX(iif(timeframe = 'AllTime', "hideCountRank", NULL)) AS "hideCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "collectedCountRank", NULL)) AS "collectedCountDayRank",
	MAX(iif(timeframe = 'Week', "collectedCountRank", NULL)) AS "collectedCountWeekRank",
	MAX(iif(timeframe = 'Month', "collectedCountRank", NULL)) AS "collectedCountMonthRank",
	MAX(iif(timeframe = 'Year', "collectedCountRank", NULL)) AS "collectedCountYearRank",
	MAX(iif(timeframe = 'AllTime', "collectedCountRank", NULL)) AS "collectedCountAllTimeRank",
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
GROUP BY "articleId";
---
-- Club Stats View
DROP TABLE IF EXISTS "ClubStat" CASCADE;
---
DROP VIEW IF EXISTS "ClubStat" CASCADE;
---
CREATE VIEW "ClubStat" AS
WITH stats_timeframe AS (
	SELECT
	  m."clubId",
	  m.timeframe,
	  coalesce(m."memberCount", 0) AS "memberCount",
	  coalesce(m."resourceCount", 0) AS "resourceCount",
	  coalesce(m."clubPostCount", 0) AS "clubPostCount"
	FROM "ClubMetric" m
	GROUP BY m."clubId", m.timeframe
)
SELECT
"clubId",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountAllTime",
MAX(iif(timeframe = 'Day'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountDay",
MAX(iif(timeframe = 'Week'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountWeek",
MAX(iif(timeframe = 'Month'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountMonth",
MAX(iif(timeframe = 'Year'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountYear",
MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountAllTime"
from stats_timeframe
GROUP BY "clubId";
---
-- Club Rank View
DROP VIEW IF EXISTS "ClubRank_Live" CASCADE;
---
CREATE VIEW "ClubRank_Live" AS
WITH timeframe_stats AS (
	SELECT
		m."clubId",
		m."memberCount",
		m."resourceCount",
		m."clubPostCount",
		m.timeframe
	FROM "ClubMetric" m
), timeframe_rank AS (
	SELECT
		"clubId",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("memberCount", 0)) DESC, (COALESCE("resourceCount", 0)) DESC, "clubId" DESC) AS "memberCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("resourceCount", 0)) DESC, (COALESCE("clubPostCount", 0)) DESC, "clubId" DESC) AS "resourceCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("clubPostCount", 0)) DESC, (COALESCE("memberCount", 0)) DESC, "clubId" DESC) AS "clubPostCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"clubId",
	MAX(iif(timeframe = 'Day', "memberCountRank", NULL)) AS "memberCountDayRank",
	MAX(iif(timeframe = 'Week', "memberCountRank", NULL)) AS "memberCountWeekRank",
	MAX(iif(timeframe = 'Month', "memberCountRank", NULL)) AS "memberCountMonthRank",
	MAX(iif(timeframe = 'Year', "memberCountRank", NULL)) AS "memberCountYearRank",
	MAX(iif(timeframe = 'AllTime', "memberCountRank", NULL)) AS "memberCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "resourceCountRank", NULL)) AS "resourceCountDayRank",
	MAX(iif(timeframe = 'Week', "resourceCountRank", NULL)) AS "resourceCountWeekRank",
	MAX(iif(timeframe = 'Month', "resourceCountRank", NULL)) AS "resourceCountMonthRank",
	MAX(iif(timeframe = 'Year', "resourceCountRank", NULL)) AS "resourceCountYearRank",
	MAX(iif(timeframe = 'AllTime', "resourceCountRank", NULL)) AS "resourceCountAllTimeRank",
	MAX(iif(timeframe = 'Day', "clubPostCountRank", NULL)) AS "clubPostCountDayRank",
	MAX(iif(timeframe = 'Week', "clubPostCountRank", NULL)) AS "clubPostCountWeekRank",
	MAX(iif(timeframe = 'Month', "clubPostCountRank", NULL)) AS "clubPostCountMonthRank",
	MAX(iif(timeframe = 'Year', "clubPostCountRank", NULL)) AS "clubPostCountYearRank",
	MAX(iif(timeframe = 'AllTime', "clubPostCountRank", NULL)) AS "clubPostCountAllTimeRank"
FROM timeframe_rank
GROUP BY "clubId";
---
-- Posts Rank View
DROP VIEW IF EXISTS "PostRank_Live" CASCADE;
---
CREATE VIEW "PostRank_Live" AS
WITH timeframe_stats as (
	SELECT
		"postId",
		"heartCount",
		"likeCount",
		"dislikeCount",
		"laughCount",
		"cryCount",
		"commentCount",
		"heartCount" + "likeCount" + "dislikeCount" + "laughCount" + "cryCount" "reactionCount",
		"collectedCount",
		timeframe
	FROM "PostMetric"
), timeframe_rank as (
	SELECT
		"postId",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "postId" DESC) "heartCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("likeCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, "postId" DESC) "likeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("dislikeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "dislikeCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("laughCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "laughCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("cryCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "cryCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("commentCount", 0)) DESC, "postId" DESC) "reactionCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("commentCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "postId" DESC) "commentCountRank",
		ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY (COALESCE("collectedCount", 0)) DESC, (COALESCE("reactionCount", 0)) DESC, (COALESCE("heartCount", 0)) DESC, (COALESCE("likeCount", 0)) DESC, (COALESCE("laughCount", 0)) DESC, "postId" DESC) "collectedCountRank",
		timeframe
	FROM timeframe_stats
)
SELECT
	"postId",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "heartCountRank", NULL)) "heartCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "likeCountRank", NULL)) "likeCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "dislikeCountRank", NULL)) "dislikeCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "laughCountRank", NULL)) "laughCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "cryCountRank", NULL)) "cryCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "reactionCountRank", NULL)) "reactionCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "commentCountRank", NULL)) "commentCountAllTimeRank",
	MAX(iif(timeframe = 'Day'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountDayRank",
	MAX(iif(timeframe = 'Week'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountWeekRank",
	MAX(iif(timeframe = 'Month'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountMonthRank",
	MAX(iif(timeframe = 'Year'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountYearRank",
	MAX(iif(timeframe = 'AllTime'::"MetricTimeframe", "collectedCountRank", NULL)) "collectedCountAllTimeRank"
FROM timeframe_rank
GROUP BY "postId";
