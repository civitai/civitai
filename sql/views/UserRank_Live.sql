 WITH user_positions AS (
         SELECT lr."userId",
            lr."leaderboardId",
            l.title,
            lr."position",
            row_number() OVER (PARTITION BY lr."userId" ORDER BY lr."position") AS row_num
           FROM (("User" u_1
             JOIN "LeaderboardResult" lr ON ((lr."userId" = u_1.id)))
             JOIN "Leaderboard" l ON (((l.id = lr."leaderboardId") AND l.public)))
          WHERE ((lr.date = CURRENT_DATE) AND ((u_1."leaderboardShowcase" IS NULL) OR (lr."leaderboardId" = u_1."leaderboardShowcase")))
        ), lowest_position AS (
         SELECT up."userId",
            up."position",
            up."leaderboardId",
            up.title AS "leaderboardTitle",
            ( SELECT (c.data ->> 'url'::text)
                   FROM "Cosmetic" c
                  WHERE ((c."leaderboardId" = up."leaderboardId") AND (up."position" <= c."leaderboardPosition"))
                  ORDER BY c."leaderboardPosition"
                 LIMIT 1) AS "leaderboardCosmetic"
           FROM user_positions up
          WHERE (up.row_num = 1)
        )
 SELECT us."userId",
    lp."position" AS "leaderboardRank",
    lp."leaderboardId",
    lp."leaderboardTitle",
    lp."leaderboardCosmetic",
    row_number() OVER (ORDER BY us."downloadCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."userId") AS "downloadCountDayRank",
    row_number() OVER (ORDER BY us."favoriteCountDay" DESC, us."ratingDay" DESC, us."ratingCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "favoriteCountDayRank",
    row_number() OVER (ORDER BY us."ratingCountDay" DESC, us."ratingDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "ratingCountDayRank",
    row_number() OVER (ORDER BY us."ratingDay" DESC, us."ratingCountDay" DESC, us."favoriteCountDay" DESC, us."downloadCountDay" DESC, us."userId") AS "ratingDayRank",
    row_number() OVER (ORDER BY us."followerCountDay" DESC, us."downloadCountDay" DESC, us."favoriteCountDay" DESC, us."ratingCountDay" DESC, us."userId") AS "followerCountDayRank",
    row_number() OVER (ORDER BY us."downloadCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."userId") AS "downloadCountWeekRank",
    row_number() OVER (ORDER BY us."favoriteCountWeek" DESC, us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "favoriteCountWeekRank",
    row_number() OVER (ORDER BY us."ratingCountWeek" DESC, us."ratingWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "ratingCountWeekRank",
    row_number() OVER (ORDER BY us."ratingWeek" DESC, us."ratingCountWeek" DESC, us."favoriteCountWeek" DESC, us."downloadCountWeek" DESC, us."userId") AS "ratingWeekRank",
    row_number() OVER (ORDER BY us."followerCountWeek" DESC, us."downloadCountWeek" DESC, us."favoriteCountWeek" DESC, us."ratingCountWeek" DESC, us."userId") AS "followerCountWeekRank",
    row_number() OVER (ORDER BY us."downloadCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."userId") AS "downloadCountMonthRank",
    row_number() OVER (ORDER BY us."favoriteCountMonth" DESC, us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "favoriteCountMonthRank",
    row_number() OVER (ORDER BY us."ratingCountMonth" DESC, us."ratingMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "ratingCountMonthRank",
    row_number() OVER (ORDER BY us."ratingMonth" DESC, us."ratingCountMonth" DESC, us."favoriteCountMonth" DESC, us."downloadCountMonth" DESC, us."userId") AS "ratingMonthRank",
    row_number() OVER (ORDER BY us."followerCountMonth" DESC, us."downloadCountMonth" DESC, us."favoriteCountMonth" DESC, us."ratingCountMonth" DESC, us."userId") AS "followerCountMonthRank",
    row_number() OVER (ORDER BY us."downloadCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."userId") AS "downloadCountYearRank",
    row_number() OVER (ORDER BY us."favoriteCountYear" DESC, us."ratingYear" DESC, us."ratingCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "favoriteCountYearRank",
    row_number() OVER (ORDER BY us."ratingCountYear" DESC, us."ratingYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "ratingCountYearRank",
    row_number() OVER (ORDER BY us."ratingYear" DESC, us."ratingCountYear" DESC, us."favoriteCountYear" DESC, us."downloadCountYear" DESC, us."userId") AS "ratingYearRank",
    row_number() OVER (ORDER BY us."followerCountYear" DESC, us."downloadCountYear" DESC, us."favoriteCountYear" DESC, us."ratingCountYear" DESC, us."userId") AS "followerCountYearRank",
    row_number() OVER (ORDER BY us."downloadCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."userId") AS "downloadCountAllTimeRank",
    row_number() OVER (ORDER BY us."favoriteCountAllTime" DESC, us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "favoriteCountAllTimeRank",
    row_number() OVER (ORDER BY us."ratingCountAllTime" DESC, us."ratingAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "ratingCountAllTimeRank",
    row_number() OVER (ORDER BY us."ratingAllTime" DESC, us."ratingCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."downloadCountAllTime" DESC, us."userId") AS "ratingAllTimeRank",
    row_number() OVER (ORDER BY us."followerCountAllTime" DESC, us."downloadCountAllTime" DESC, us."favoriteCountAllTime" DESC, us."ratingCountAllTime" DESC, us."userId") AS "followerCountAllTimeRank",
    row_number() OVER (ORDER BY us."answerCountDay" DESC, us."answerAcceptCountDay" DESC, us."userId") AS "answerCountDayRank",
    row_number() OVER (ORDER BY us."answerCountWeek" DESC, us."answerAcceptCountWeek" DESC, us."userId") AS "answerCountWeekRank",
    row_number() OVER (ORDER BY us."answerCountMonth" DESC, us."answerAcceptCountMonth" DESC, us."userId") AS "answerCountMonthRank",
    row_number() OVER (ORDER BY us."answerCountYear" DESC, us."answerAcceptCountYear" DESC, us."userId") AS "answerCountYearRank",
    row_number() OVER (ORDER BY us."answerCountAllTime" DESC, us."answerAcceptCountAllTime" DESC, us."userId") AS "answerCountAllTimeRank",
    row_number() OVER (ORDER BY us."answerAcceptCountDay" DESC, us."answerCountDay" DESC, us."userId") AS "answerAcceptCountDayRank",
    row_number() OVER (ORDER BY us."answerAcceptCountWeek" DESC, us."answerCountWeek" DESC, us."userId") AS "answerAcceptCountWeekRank",
    row_number() OVER (ORDER BY us."answerAcceptCountMonth" DESC, us."answerCountMonth" DESC, us."userId") AS "answerAcceptCountMonthRank",
    row_number() OVER (ORDER BY us."answerAcceptCountYear" DESC, us."answerCountYear" DESC, us."userId") AS "answerAcceptCountYearRank",
    row_number() OVER (ORDER BY us."answerAcceptCountAllTime" DESC, us."answerCountAllTime" DESC, us."userId") AS "answerAcceptCountAllTimeRank"
   FROM (("UserStat" us
     JOIN "User" u ON ((u.id = us."userId")))
     LEFT JOIN lowest_position lp ON ((lp."userId" = us."userId")));