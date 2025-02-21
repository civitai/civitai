/*
  Warnings:

  - You are about to drop the column `earlyAccessTimeFrame` on the `ModelVersion` table. All the data in the column will be lost.
  - You are about to drop the column `onboardingSteps` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `tos` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Notification` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `NotificationViewed` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[stripeAccountId]` on the table `UserPaymentConfiguration` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[A,B]` on the table `_LicenseToModel` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `reactionCount` to the `ImageMetric` table without a default value. This is not possible if the table is not empty.
  - Made the column `updatedAt` on table `ModelMetric` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updatedAt` on table `ModelVersionMetric` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "CashWithdrawalStatus" AS ENUM ('Paid', 'Rejected', 'Scheduled', 'Submitted', 'Deferred', 'DeferredInternal', 'Canceled', 'Cleared', 'FraudReview', 'PendingPayerFunds', 'InternalValue', 'FailedFee');

-- CreateEnum
CREATE TYPE "CashWithdrawalMethod" AS ENUM ('NotProvided', 'WireTransfer', 'Payoneer', 'PayPal', 'ACH', 'Check', 'ECheck', 'HoldPayments', 'Custom', 'Intercash', 'Card', 'TipaltiInternalValue');

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- DropIndex
DROP INDEX "ChatMember_userId_status_muted_idx";

-- DropIndex
DROP INDEX "EntityCollaborator_userId_entityType_entityId_idx";

-- DropIndex
DROP INDEX "user_deletedat_idx";

-- DropIndex
DROP INDEX "userengagement_type_userid";

-- AlterTable
ALTER TABLE "EntityAccess" ALTER COLUMN "permissions" SET DEFAULT 1024;

-- AlterTable
ALTER TABLE "Image" ALTER COLUMN "pHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN     "reactionCount" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Model" ALTER COLUMN "allowCommercialUse" SET DEFAULT ARRAY['Sell']::"CommercialUse"[];

-- AlterTable
ALTER TABLE "ModelMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ModelVersion" DROP COLUMN "earlyAccessTimeFrame";

-- AlterTable
ALTER TABLE "ModelVersionMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ResourceReview" ALTER COLUMN "recommended" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "onboardingSteps",
DROP COLUMN "tos",
ADD COLUMN     "meta" JSONB DEFAULT '{}';

-- AlterTable
ALTER TABLE "UserPaymentConfiguration" ALTER COLUMN "tipaltiAccountStatus" SET DEFAULT 'PendingOnboarding';

-- DropTable
DROP TABLE "ArticleRank";

-- DropTable
DROP TABLE "ImageRank";

-- DropTable
DROP TABLE "ModelRank";

-- DropTable
DROP TABLE "ModelVersionRank";

-- DropTable
DROP TABLE "Notification";

-- DropTable
DROP TABLE "NotificationViewed";

-- DropTable
DROP TABLE "PostRank";

-- DropTable
DROP TABLE "TagRank";

-- DropTable
DROP TABLE "UserRank";

-- DropEnum
DROP TYPE "NotificationCategory";

-- DropEnum
DROP TYPE "OnboardingStep";

-- CreateTable
CREATE TABLE "CashWithdrawal" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" "CashWithdrawalMethod" NOT NULL,
    "fee" INTEGER NOT NULL,
    "status" "CashWithdrawalStatus" NOT NULL,
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashWithdrawal_transactionId_key" ON "CashWithdrawal"("transactionId");

-- CreateIndex
CREATE INDEX "CashWithdrawal_userId_idx" ON "CashWithdrawal"("userId");

-- CreateIndex
CREATE INDEX "EntityCollaborator_userId_entityType_entityId_idx" ON "EntityCollaborator"("userId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPaymentConfiguration_stripeAccountId_key" ON "UserPaymentConfiguration"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "_LicenseToModel_AB_unique" ON "_LicenseToModel"("A", "B");

-- CreateIndex
CREATE INDEX "_LicenseToModel_B_index" ON "_LicenseToModel"("B");

-- AddForeignKey
ALTER TABLE "CashWithdrawal" ADD CONSTRAINT "CashWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageConnection" ADD CONSTRAINT "ImageConnection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
