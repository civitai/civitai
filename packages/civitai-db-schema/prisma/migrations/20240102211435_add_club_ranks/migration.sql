-- Club Stats View
DROP VIEW IF EXISTS "ClubStat";
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
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "memberCount", NULL)) AS "memberCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "resourceCount", NULL)) AS "resourceCountAllTime",
MAX(IIF(timeframe = 'Day'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountDay",
MAX(IIF(timeframe = 'Week'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountWeek",
MAX(IIF(timeframe = 'Month'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountMonth",
MAX(IIF(timeframe = 'Year'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountYear",
MAX(IIF(timeframe = 'AllTime'::"MetricTimeframe", "clubPostCount", NULL)) AS "clubPostCountAllTime"
from stats_timeframe
GROUP BY "clubId";

-- Club Rank View
drop view if exists "ClubRank_Live";
create or replace view "ClubRank_Live" as
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