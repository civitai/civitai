/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[coverId]` on the table `Article` will be added. If there are existing duplicate values, this will fail.
  - Made the column `userId` on table `NotificationViewed` required. This step will fail if there are existing NULL values in that column.
  - Made the column `muted` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "PurchasableRewardUsage" AS ENUM ('SingleUse', 'MultiUse');

-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "NotificationViewed_userId";

-- AlterTable
ALTER TABLE "NotificationViewed" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "muted" SET NOT NULL,
ALTER COLUMN "muted" SET DEFAULT false;

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
CREATE TABLE "PurchasableReward" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "about" TEXT NOT NULL,
    "redeemDetails" TEXT NOT NULL,
    "termsOfUse" TEXT NOT NULL,
    "usage" "PurchasableRewardUsage" NOT NULL,
    "codes" TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "availableFrom" TIMESTAMP(3),
    "availableTo" TIMESTAMP(3),
    "availableCount" INTEGER,
    "addedById" INTEGER,
    "coverImageId" INTEGER,

    CONSTRAINT "PurchasableReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPurchasedRewards" (
    "buzzTransactionId" TEXT NOT NULL,
    "userId" INTEGER,
    "purchasableRewardId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "code" TEXT NOT NULL,

    CONSTRAINT "UserPurchasedRewards_pkey" PRIMARY KEY ("buzzTransactionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_coverId_key" ON "Article"("coverId");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "Image"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasableReward" ADD CONSTRAINT "PurchasableReward_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasableReward" ADD CONSTRAINT "PurchasableReward_coverImageId_fkey" FOREIGN KEY ("coverImageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPurchasedRewards" ADD CONSTRAINT "UserPurchasedRewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPurchasedRewards" ADD CONSTRAINT "UserPurchasedRewards_purchasableRewardId_fkey" FOREIGN KEY ("purchasableRewardId") REFERENCES "PurchasableReward"("id") ON DELETE SET NULL ON UPDATE CASCADE;
