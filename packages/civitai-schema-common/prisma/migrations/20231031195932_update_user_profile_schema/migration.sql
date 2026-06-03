-- DropForeignKey
ALTER TABLE "UserProfileShowcaseItem" DROP CONSTRAINT "UserProfileShowcaseItem_profileId_fkey";

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "location" TEXT,
ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showcaseItems" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "profileSectionsSettings" SET DEFAULT '[{"key":"showcase","enabled":true},{"key":"popularModels","enabled":true},{"key":"popularArticles","enabled":true},{"key":"modelsOverview","enabled":true},{"key":"imagesOverview","enabled":true},{"key":"recentReviews","enabled":true}]';

-- DropTable
DROP TABLE "UserProfileShowcaseItem";
