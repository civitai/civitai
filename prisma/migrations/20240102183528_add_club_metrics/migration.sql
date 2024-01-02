/*
  Warnings:

  - You are about to drop the column `cryCount` on the `ClubPostMetric` table. All the data in the column will be lost.
  - You are about to drop the column `dislikeCount` on the `ClubPostMetric` table. All the data in the column will be lost.
  - You are about to drop the column `heartCount` on the `ClubPostMetric` table. All the data in the column will be lost.
  - You are about to drop the column `laughCount` on the `ClubPostMetric` table. All the data in the column will be lost.
  - You are about to drop the column `likeCount` on the `ClubPostMetric` table. All the data in the column will be lost.
  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `userId` on table `NotificationViewed` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "NotificationViewed_userId";

-- AlterTable
ALTER TABLE "ClubPostMetric" DROP COLUMN "cryCount",
DROP COLUMN "dislikeCount",
DROP COLUMN "heartCount",
DROP COLUMN "laughCount",
DROP COLUMN "likeCount",
ADD COLUMN     "clubPostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "memberCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resourceCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "NotificationViewed" ALTER COLUMN "userId" SET NOT NULL;

-- DropTable
DROP TABLE "ArticleRank";

-- DropTable
DROP TABLE "ImageRank";

-- DropTable
DROP TABLE "ModelRank";

-- DropTable
DROP TABLE "ModelVersionRank";

-- DropTable
DROP TABLE "PostRank";

-- DropTable
DROP TABLE "TagRank";

-- DropTable
DROP TABLE "UserRank";

-- CreateTable
CREATE TABLE "ClubMetric" (
    "clubId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "dislikeCount" INTEGER NOT NULL DEFAULT 0,
    "laughCount" INTEGER NOT NULL DEFAULT 0,
    "cryCount" INTEGER NOT NULL DEFAULT 0,
    "heartCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubMetric_pkey" PRIMARY KEY ("clubId","timeframe")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClubMetric" ADD CONSTRAINT "ClubMetric_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
