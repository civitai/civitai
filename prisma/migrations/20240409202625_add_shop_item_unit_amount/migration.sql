/*
  Warnings:

  - You are about to drop the column `unitValue` on the `CosmeticShopItem` table. All the data in the column will be lost.
  - You are about to drop the column `onboardingSteps` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `tos` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `unitValue` on the `UserCosmeticShopPurchases` table. All the data in the column will be lost.
  - You are about to drop the `ArticleRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImageRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ModelVersionRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PostRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TagRank` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserRank` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `unitAmount` to the `CosmeticShopItem` table without a default value. This is not possible if the table is not empty.
  - Made the column `updatedAt` on table `ModelMetric` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updatedAt` on table `ModelVersionMetric` required. This step will fail if there are existing NULL values in that column.
  - Made the column `userId` on table `NotificationViewed` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `unitAmount` to the `UserCosmeticShopPurchases` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "CosmeticType" ADD VALUE 'ProfileDecoration';

-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "NotificationViewed_userId";

-- AlterTable
ALTER TABLE "CosmeticShopItem" DROP COLUMN "unitValue",
ADD COLUMN     "unitAmount" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Model" ALTER COLUMN "allowCommercialUse" SET DEFAULT ARRAY['Sell']::"CommercialUse"[];

-- AlterTable
ALTER TABLE "ModelMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ALTER COLUMN "updatedAt" SET NOT NULL,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "NotificationViewed" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ResourceReview" ALTER COLUMN "recommended" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "onboardingSteps",
DROP COLUMN "tos";

-- AlterTable
ALTER TABLE "UserCosmeticShopPurchases" DROP COLUMN "unitValue",
ADD COLUMN     "unitAmount" INTEGER NOT NULL;

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

-- DropEnum
DROP TYPE "OnboardingStep";

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

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
