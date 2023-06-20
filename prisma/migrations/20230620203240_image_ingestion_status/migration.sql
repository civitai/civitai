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
-- CreateEnum
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "blockedFor" TEXT,
ADD COLUMN     "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Pending';

UPDATE "Image"
SET "ingestion" = 'Scanned'
WHERE "scannedAt" IS NOT NULL

-- -- DropTable
-- DROP TABLE "ArticleRank";

-- -- DropTable
-- DROP TABLE "ImageRank";

-- -- DropTable
-- DROP TABLE "ModelRank";

-- -- DropTable
-- DROP TABLE "ModelVersionRank";

-- -- DropTable
-- DROP TABLE "PostRank";

-- -- DropTable
-- DROP TABLE "TagRank";

-- -- DropTable
-- DROP TABLE "UserRank";

-- -- CreateTable
-- CREATE TABLE "QuestionRank" (
--     "questionId" INTEGER NOT NULL,
--     "answerCountDay" INTEGER NOT NULL,
--     "answerCountWeek" INTEGER NOT NULL,
--     "answerCountMonth" INTEGER NOT NULL,
--     "answerCountYear" INTEGER NOT NULL,
--     "answerCountAllTime" INTEGER NOT NULL,
--     "heartCountDay" INTEGER NOT NULL,
--     "heartCountWeek" INTEGER NOT NULL,
--     "heartCountMonth" INTEGER NOT NULL,
--     "heartCountYear" INTEGER NOT NULL,
--     "heartCountAllTime" INTEGER NOT NULL,
--     "commentCountDay" INTEGER NOT NULL,
--     "commentCountWeek" INTEGER NOT NULL,
--     "commentCountMonth" INTEGER NOT NULL,
--     "commentCountYear" INTEGER NOT NULL,
--     "commentCountAllTime" INTEGER NOT NULL,
--     "answerCountDayRank" INTEGER NOT NULL,
--     "answerCountWeekRank" INTEGER NOT NULL,
--     "answerCountMonthRank" INTEGER NOT NULL,
--     "answerCountYearRank" INTEGER NOT NULL,
--     "answerCountAllTimeRank" INTEGER NOT NULL,
--     "heartCountDayRank" INTEGER NOT NULL,
--     "heartCountWeekRank" INTEGER NOT NULL,
--     "heartCountMonthRank" INTEGER NOT NULL,
--     "heartCountYearRank" INTEGER NOT NULL,
--     "heartCountAllTimeRank" INTEGER NOT NULL,
--     "commentCountDayRank" INTEGER NOT NULL,
--     "commentCountWeekRank" INTEGER NOT NULL,
--     "commentCountMonthRank" INTEGER NOT NULL,
--     "commentCountYearRank" INTEGER NOT NULL,
--     "commentCountAllTimeRank" INTEGER NOT NULL,

--     CONSTRAINT "QuestionRank_pkey" PRIMARY KEY ("questionId")
-- );

-- -- AddForeignKey
-- ALTER TABLE "QuestionRank" ADD CONSTRAINT "QuestionRank_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
