
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "leaderboardShowcase" TEXT;

-- Update UserRank view
DROP VIEW IF EXISTS "UserRank_Live";
CREATE VIEW "UserRank_Live" AS
WITH user_positions AS (
  SELECT
    lr."userId",
    lr."leaderboardId",
    l."title",
    lr.position,
    row_number() OVER (PARTITION BY "userId" ORDER BY "position") row_num
  FROM "User" u
  JOIN "LeaderboardResult" lr ON lr."userId" = u.id
  JOIN "Leaderboard" l ON l.id = lr."leaderboardId" AND l.public
  WHERE lr.date = current_date
    AND (
      u."leaderboardShowcase" IS NULL
      OR lr."leaderboardId" = u."leaderboardShowcase"
    )
  ), lowest_position AS (
  SELECT
    up."userId",
    up.position,
    up."leaderboardId",
    up."title" "leaderboardTitle",
    (
      SELECT data->>'url'
      FROM "Cosmetic" c
      WHERE c."leaderboardId" = up."leaderboardId"
        AND up.position <= c."leaderboardPosition"
      ORDER BY c."leaderboardPosition"
      LIMIT 1
    ) as "leaderboardCosmetic"
  FROM user_positions up
  WHERE row_num = 1
  )
  SELECT
  us."userId",
  lp.position "leaderboardRank",
  lp."leaderboardId",
  lp."leaderboardTitle",
  lp."leaderboardCosmetic",
  ROW_NUMBER() OVER (ORDER BY "downloadCountDay" DESC, "ratingDay" DESC, "ratingCountDay" DESC, "favoriteCountDay" DESC, us."userId") AS "downloadCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "favoriteCountDay" DESC, "ratingDay" DESC, "ratingCountDay" DESC, "downloadCountDay" DESC, us."userId") AS "favoriteCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "ratingCountDay" DESC, "ratingDay" DESC, "favoriteCountDay" DESC, "downloadCountDay" DESC, us."userId") AS "ratingCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "ratingDay" DESC, "ratingCountDay" DESC, "favoriteCountDay" DESC, "downloadCountDay" DESC, us."userId") AS "ratingDayRank",
  ROW_NUMBER() OVER (ORDER BY "followerCountDay" DESC, "downloadCountDay" DESC, "favoriteCountDay" DESC, "ratingCountDay" DESC, us."userId") AS "followerCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "downloadCountWeek" DESC, "ratingWeek" DESC, "ratingCountWeek" DESC, "favoriteCountWeek" DESC, us."userId") AS "downloadCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "favoriteCountWeek" DESC, "ratingWeek" DESC, "ratingCountWeek" DESC, "downloadCountWeek" DESC, us."userId") AS "favoriteCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "ratingCountWeek" DESC, "ratingWeek" DESC, "favoriteCountWeek" DESC, "downloadCountWeek" DESC, us."userId") AS "ratingCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "ratingWeek" DESC, "ratingCountWeek" DESC, "favoriteCountWeek" DESC, "downloadCountWeek" DESC, us."userId") AS "ratingWeekRank",
  ROW_NUMBER() OVER (ORDER BY "followerCountWeek" DESC, "downloadCountWeek" DESC, "favoriteCountWeek" DESC, "ratingCountWeek" DESC, us."userId") AS "followerCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "downloadCountMonth" DESC, "ratingMonth" DESC, "ratingCountMonth" DESC, "favoriteCountMonth" DESC, us."userId") AS "downloadCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "favoriteCountMonth" DESC, "ratingMonth" DESC, "ratingCountMonth" DESC, "downloadCountMonth" DESC, us."userId") AS "favoriteCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "ratingCountMonth" DESC, "ratingMonth" DESC, "favoriteCountMonth" DESC, "downloadCountMonth" DESC, us."userId") AS "ratingCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "ratingMonth" DESC, "ratingCountMonth" DESC, "favoriteCountMonth" DESC, "downloadCountMonth" DESC, us."userId") AS "ratingMonthRank",
  ROW_NUMBER() OVER (ORDER BY "followerCountMonth" DESC, "downloadCountMonth" DESC, "favoriteCountMonth" DESC, "ratingCountMonth" DESC, us."userId") AS "followerCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "downloadCountYear" DESC, "ratingYear" DESC, "ratingCountYear" DESC, "favoriteCountYear" DESC, us."userId") AS "downloadCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "favoriteCountYear" DESC, "ratingYear" DESC, "ratingCountYear" DESC, "downloadCountYear" DESC, us."userId") AS "favoriteCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "ratingCountYear" DESC, "ratingYear" DESC, "favoriteCountYear" DESC, "downloadCountYear" DESC, us."userId") AS "ratingCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "ratingYear" DESC, "ratingCountYear" DESC, "favoriteCountYear" DESC, "downloadCountYear" DESC, us."userId") AS "ratingYearRank",
  ROW_NUMBER() OVER (ORDER BY "followerCountYear" DESC, "downloadCountYear" DESC, "favoriteCountYear" DESC, "ratingCountYear" DESC, us."userId") AS "followerCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "downloadCountAllTime" DESC, "ratingAllTime" DESC, "ratingCountAllTime" DESC, "favoriteCountAllTime" DESC, us."userId") AS "downloadCountAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "favoriteCountAllTime" DESC, "ratingAllTime" DESC, "ratingCountAllTime" DESC, "downloadCountAllTime" DESC, us."userId") AS "favoriteCountAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "ratingCountAllTime" DESC, "ratingAllTime" DESC, "favoriteCountAllTime" DESC, "downloadCountAllTime" DESC, us."userId") AS "ratingCountAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "ratingAllTime" DESC, "ratingCountAllTime" DESC, "favoriteCountAllTime" DESC, "downloadCountAllTime" DESC, us."userId") AS "ratingAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "downloadCountAllTime" DESC, "favoriteCountAllTime" DESC, "ratingCountAllTime" DESC, us."userId") AS "followerCountAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "answerCountDay" DESC, "answerAcceptCountDay" DESC, us."userId") AS "answerCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "answerCountWeek" DESC, "answerAcceptCountWeek" DESC, us."userId") AS "answerCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "answerCountMonth" DESC, "answerAcceptCountMonth" DESC, us."userId") AS "answerCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "answerCountYear" DESC, "answerAcceptCountYear" DESC, us."userId") AS "answerCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "answerCountAllTime" DESC, "answerAcceptCountAllTime" DESC, us."userId") AS "answerCountAllTimeRank",
  ROW_NUMBER() OVER (ORDER BY "answerAcceptCountDay" DESC, "answerCountDay" DESC, us."userId") AS "answerAcceptCountDayRank",
  ROW_NUMBER() OVER (ORDER BY "answerAcceptCountWeek" DESC, "answerCountWeek" DESC, us."userId") AS "answerAcceptCountWeekRank",
  ROW_NUMBER() OVER (ORDER BY "answerAcceptCountMonth" DESC, "answerCountMonth" DESC, us."userId") AS "answerAcceptCountMonthRank",
  ROW_NUMBER() OVER (ORDER BY "answerAcceptCountYear" DESC, "answerCountYear" DESC, us."userId") AS "answerAcceptCountYearRank",
  ROW_NUMBER() OVER (ORDER BY "answerAcceptCountAllTime" DESC, "answerCountAllTime" DESC, us."userId") AS "answerAcceptCountAllTimeRank"
FROM "UserStat" us
JOIN "User" u ON u."id" = us."userId"
LEFT JOIN lowest_position lp ON lp."userId" = us."userId";
