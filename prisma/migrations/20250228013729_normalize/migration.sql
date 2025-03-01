-- AlterTable
ALTER TABLE "Image" ALTER COLUMN "pHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ImageMetric" ADD COLUMN IF NOT EXISTS     "reactionCount" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Model" ALTER COLUMN "allowCommercialUse" SET DEFAULT ARRAY['Sell']::"CommercialUse"[];

-- AlterTable
ALTER TABLE "ModelMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "onboardingSteps",
DROP COLUMN "tos",
ADD COLUMN IF NOT EXISTS     "meta" JSONB DEFAULT '{}';



-- AlterTable
ALTER TABLE "UserPaymentConfiguration" ALTER COLUMN "tipaltiAccountStatus" SET DEFAULT 'PendingOnboarding';

-- AlterTable
ALTER TABLE "_LicenseToModel" DROP CONSTRAINT IF EXISTS "_LicenseToModel_pkey";
ALTER TABLE "_LicenseToModel" ADD CONSTRAINT "_LicenseToModel_AB_pkey" PRIMARY KEY ("A", "B");

-- DropTable
DROP TABLE IF EXISTS "ArticleRank";
CREATE TABLE IF NOT EXISTS "ArticleRank"
  AS SELECT * FROM "ArticleRank_Live";

-- DropTable
DROP TABLE IF EXISTS "ImageRank";
CREATE TABLE IF NOT EXISTS "ImageRank"
  AS SELECT * FROM "ImageRank_Live";

-- DropTable
DROP TABLE IF EXISTS "ModelRank";

-- DropTable
DROP TABLE IF EXISTS "ModelVersionRank";
CREATE TABLE IF NOT EXISTS "ModelVersionRank"
  AS SELECT * FROM "ModelVersionRank_Live";

-- DropTable
DROP TABLE IF EXISTS "Notification";

-- DropTable
DROP TABLE IF EXISTS "NotificationViewed";

-- DropTable
DROP TABLE IF EXISTS "PostRank";
CREATE TABLE IF NOT EXISTS "PostRank"
  AS SELECT * FROM "PostRank_Live";

-- DropTable
DROP TABLE IF EXISTS "TagRank";
CREATE TABLE IF NOT EXISTS "TagRank"
  AS SELECT * FROM "TagRank_Live";

-- DropTable
DROP TABLE IF EXISTS "UserRank";
CREATE TABLE IF NOT EXISTS "UserRank"
    AS SELECT * FROM "UserRank_Live";

-- DropEnum
DROP TYPE "NotificationCategory";

-- DropEnum
DROP TYPE "OnboardingStep";

-- DropIndex
DROP INDEX "EntityCollaborator_userId_entityType_entityId_idx";

-- CreateIndex
CREATE INDEX "EntityCollaborator_userId_entityType_entityId_idx" ON "EntityCollaborator"("userId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPaymentConfiguration_stripeAccountId_key" ON "UserPaymentConfiguration"("stripeAccountId");

-- CreateIndex
CREATE INDEX "_LicenseToModel_B_index" ON "_LicenseToModel"("B");

-- RenameIndex
ALTER INDEX "ChatMember_userId_status_muted_idx" RENAME TO "ChatMember_userId_status_isMuted_idx";

-- RenameIndex
ALTER INDEX "PostMetric_postId_ageGroup" RENAME TO "PostMetric_postId_ageGroup_idx";

-- RenameIndex
ALTER INDEX "user_deletedat_idx" RENAME TO "User_deletedAt_idx";

-- RenameIndex
ALTER INDEX "userengagement_type_userid" RENAME TO "UserEngagement_type_userId_idx";
