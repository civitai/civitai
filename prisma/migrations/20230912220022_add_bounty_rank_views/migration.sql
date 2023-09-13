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
