-- Move data from "FavoriteModel" to "ModelEngagement"
INSERT INTO "ModelEngagement"("userId", "modelId", type, "createdAt")
SELECT fm."userId", fm."modelId", 'Favorite', "createdAt"
FROM "FavoriteModel" fm;

-- DropForeignKey
ALTER TABLE "FavoriteModel" DROP CONSTRAINT "FavoriteModel_modelId_fkey";

-- DropForeignKey
ALTER TABLE "FavoriteModel" DROP CONSTRAINT "FavoriteModel_userId_fkey";

-- DropTable
DROP TABLE "FavoriteModel";
