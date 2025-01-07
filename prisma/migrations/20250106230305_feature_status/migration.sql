
-- -- DropForeignKey
-- ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- -- DropIndex
-- DROP INDEX "ChatMember_userId_status_muted_idx";

-- -- DropIndex
-- DROP INDEX "EntityCollaborator_userId_entityType_entityId_idx";

-- -- AlterTable
-- ALTER TABLE "EntityAccess" ALTER COLUMN "permissions" SET DEFAULT 1024;

-- -- AlterTable
-- ALTER TABLE "Image" ALTER COLUMN "pHash" DROP NOT NULL;

-- -- AlterTable
-- ALTER TABLE "ImageMetric" ADD COLUMN     "reactionCount" INTEGER NOT NULL;

-- -- AlterTable
-- ALTER TABLE "Model" ALTER COLUMN "allowCommercialUse" SET DEFAULT ARRAY['Sell']::"CommercialUse"[];

-- -- AlterTable
-- ALTER TABLE "ModelMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
-- ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- -- AlterTable
-- ALTER TABLE "ModelVersion" DROP COLUMN "earlyAccessTimeFrame";

-- -- AlterTable
-- ALTER TABLE "ModelVersionMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
-- ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- -- AlterTable
-- ALTER TABLE "ResourceReview" ALTER COLUMN "recommended" DROP DEFAULT;

-- -- AlterTable
-- ALTER TABLE "User" DROP COLUMN "onboardingSteps",
-- DROP COLUMN "tos",
-- ADD COLUMN     "meta" JSONB DEFAULT '{}';

-- -- AlterTable
-- ALTER TABLE "UserPaymentConfiguration" ALTER COLUMN "tipaltiAccountStatus" SET DEFAULT 'PendingOnboarding';

-- -- DropTable
-- DROP TABLE "ArticleRank";

-- -- DropTable
-- DROP TABLE "ImageRank";

-- -- DropTable
-- DROP TABLE "ModelRank";

-- -- DropTable
-- DROP TABLE "ModelVersionRank";

-- -- DropTable
-- DROP TABLE "Notification";

-- -- DropTable
-- DROP TABLE "NotificationViewed";

-- -- DropTable
-- DROP TABLE "PostRank";

-- -- DropTable
-- DROP TABLE "TagRank";

-- -- DropTable
-- DROP TABLE "UserRank";

-- -- DropEnum
-- DROP TYPE "NotificationCategory";

-- -- DropEnum
-- DROP TYPE "OnboardingStep";

-- CreateTable
CREATE TABLE "FeatureStatus" (
    "id" SERIAL NOT NULL,
    "feature" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,

    CONSTRAINT "FeatureStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeatureStatus_feature_idx" ON "FeatureStatus"("feature");

-- CreateIndex
CREATE INDEX "FeatureStatus_createdAt_idx" ON "FeatureStatus"("createdAt");

-- -- CreateIndex
-- CREATE INDEX "EntityCollaborator_userId_entityType_entityId_idx" ON "EntityCollaborator"("userId", "entityType", "entityId");

-- -- CreateIndex
-- CREATE UNIQUE INDEX "UserPaymentConfiguration_stripeAccountId_key" ON "UserPaymentConfiguration"("stripeAccountId");

-- -- AddForeignKey
-- ALTER TABLE "ImageConnection" ADD CONSTRAINT "ImageConnection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- AddForeignKey
-- ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- AddForeignKey
-- ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- AddForeignKey
-- ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- AddForeignKey
-- ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
