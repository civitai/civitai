/*
  Warnings:

  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `userId` on table `NotificationViewed` required. This step will fail if there are existing NULL values in that column.
  - Made the column `muted` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "BuzzWithdrawalRequestStatus" AS ENUM ('Requested', 'Rejected', 'Approved', 'Reverted', 'Transfered');

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
CREATE TABLE "BuzzWithdrawalRequestHistory" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "updatedById" INTEGER,
    "status" "BuzzWithdrawalRequestStatus" NOT NULL DEFAULT 'Requested',
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuzzWithdrawalRequestHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuzzWithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" INTEGER,
    "connectedAccountId" TEXT NOT NULL,
    "requestedBuzzAmount" INTEGER NOT NULL,
    "buzzPlatformFeeAmount" INTEGER,
    "toTransferBuzzAmount" INTEGER,
    "transferedAmount" INTEGER,
    "currency" "Currency" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "BuzzWithdrawalRequestStatus" NOT NULL DEFAULT 'Requested',

    CONSTRAINT "BuzzWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequestHistory" ADD CONSTRAINT "BuzzWithdrawalRequestHistory_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuzzWithdrawalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequestHistory" ADD CONSTRAINT "BuzzWithdrawalRequestHistory_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuzzWithdrawalRequest" ADD CONSTRAINT "BuzzWithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
