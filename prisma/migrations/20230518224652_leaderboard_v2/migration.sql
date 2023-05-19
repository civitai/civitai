/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "Cosmetic" ADD COLUMN     "leaderboardId" TEXT,
ADD COLUMN     "leaderboardPosition" INTEGER;

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "statusSetBy" INTEGER;

-- CreateTable
CREATE TABLE "Leaderboard" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scoringDescription" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "public" BOOLEAN NOT NULL,

    CONSTRAINT "Leaderboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardResult" (
    "leaderboardId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "position" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardResult_pkey" PRIMARY KEY ("leaderboardId","date","position")
);

-- CreateIndex
CREATE INDEX "LeaderboardResult_userId_idx" ON "LeaderboardResult" USING HASH ("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardResult_leaderboardId_date_userId_key" ON "LeaderboardResult"("leaderboardId", "date", "userId");

-- AddForeignKey
ALTER TABLE "LeaderboardResult" ADD CONSTRAINT "LeaderboardResult_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardResult" ADD CONSTRAINT "LeaderboardResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Update rank view
DROP VIEW IF EXISTS "UserRank_Live";
CREATE VIEW "UserRank_Live" AS
WITH user_positions AS (
	SELECT
	  "userId",
	  "leaderboardId",
	  "position",
	  row_number() OVER (PARTITION BY "userId" ORDER BY "position") row_num
	FROM "LeaderboardResult"
	WHERE date = current_date
), lowest_position AS (
	SELECT
	  up."userId",
	  up.position,
	  up."leaderboardId",
	  l.title "leaderboardTitle"
	FROM user_positions up
	JOIN "Leaderboard" l ON l.id = up."leaderboardId"
	WHERE row_num = 1
)
SELECT
  us."userId",
  lp.position "leaderboardRank",
  lp."leaderboardId",
  lp."leaderboardTitle",
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
LEFT JOIN lowest_position lp ON lp."userId" = us."userId"