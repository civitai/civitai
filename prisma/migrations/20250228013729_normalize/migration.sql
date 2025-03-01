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
ALTER TABLE "_LicenseToModel" ADD CONSTRAINT "_LicenseToModel_AB_pkey" PRIMARY KEY ("A", "B");

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
