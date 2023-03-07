-- Update leaderboard rank to exlude deleted users
DROP MATERIALIZED VIEW "UserRank";
CREATE MATERIALIZED VIEW "UserRank" AS
SELECT
  "userId",
  ROW_NUMBER() OVER (ORDER BY
    IIF ("userId" = -1 OR u."deletedAt" IS NOT NULL, -100::double precision,
	    (
	      ("downloadCountMonth" / 100 * 1) +
		    ("ratingMonth" * "ratingCountMonth" * 10) +
		    ("favoriteCountMonth" * 5) +
	      ("answerCountMonth" * 3) +
	      ("answerAcceptCountMonth" * 5)
	    ) / (1 + 10 + 5 + 3 + 5)
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
	ROW_NUMBER() OVER (ORDER BY "followerCountAllTime" DESC, "downloadCountAllTime" DESC, "favoriteCountAllTime" DESC, "ratingCountAllTime" DESC, "userId") AS "followerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountDay" DESC, "answerAcceptCountDay" DESC, "userId") AS "answerCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountWeek" DESC, "answerAcceptCountWeek" DESC, "userId") AS "answerCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountMonth" DESC, "answerAcceptCountMonth" DESC, "userId") AS "answerCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountYear" DESC, "answerAcceptCountYear" DESC, "userId") AS "answerCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "answerCountAllTime" DESC, "answerAcceptCountAllTime" DESC, "userId") AS "answerCountAllTimeRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountDay" DESC, "answerCountDay" DESC, "userId") AS "answerAcceptCountDayRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountWeek" DESC, "answerCountWeek" DESC, "userId") AS "answerAcceptCountWeekRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountMonth" DESC, "answerCountMonth" DESC, "userId") AS "answerAcceptCountMonthRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountYear" DESC, "answerCountYear" DESC, "userId") AS "answerAcceptCountYearRank",
	ROW_NUMBER() OVER (ORDER BY "answerAcceptCountAllTime" DESC, "answerCountAllTime" DESC, "userId") AS "answerAcceptCountAllTimeRank"
FROM "UserStat" us
JOIN "User" u ON u."id" = us."userId"