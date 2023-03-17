/*
 Warnings:

 - A unique constraint covering the columns `[modelVersionId,userId]` on the table `ResourceReview` will be added. If there are existing duplicate values, this will fail.
 - Added the required column `updatedAt` to the `ResourceReview` table without a default value. This is not possible if the table is not empty.

 */
-- AlterTable
ALTER TABLE
  "ResourceReview"
ADD
  COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD
  COLUMN "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN
  "details" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ImageResource_imageId_idx" ON "ImageResource" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "ResourceReview_modelVersionId_idx" ON "ResourceReview" USING HASH ("modelVersionId");

-- CreateIndex
CREATE INDEX "ResourceReview_userId_idx" ON "ResourceReview" USING HASH ("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReview_modelVersionId_userId_key" ON "ResourceReview"("modelVersionId", "userId");

-- Create ImageResourceHelper View
CREATE
OR REPLACE VIEW "ImageResourceHelper" AS
SELECT
  ir.id "id",
  ir."imageId",
  rr.id "reviewId",
  rr.rating "reviewRating",
  rr.details "reviewDetails",
  rr."createdAt" "reviewCreatedAt",
  ir.name,
  mv.id "modelVersionId",
  mv.name "modelVersionName",
  mv."createdAt" "modelVersionCreatedAt",
  m.id "modelId",
  m.name "modelName",
  mr."ratingAllTime" "modelRating",
  mr."ratingCountAllTime" "modelRatingCount",
  mr."downloadCountAllTime" "modelDownloadCount",
  mr."commentCountAllTime" "modelCommentCount",
  mr."favoriteCountAllTime" "modelFavoriteCount",
  m.type "modelType",
  i."postId" "postId"
FROM
  "ImageResource" ir
  JOIN "Image" i ON i.id = ir."imageId"
  LEFT JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
  LEFT JOIN "Model" m ON m.id = mv."modelId"
  LEFT JOIN "ModelRank" mr ON mr."modelId" = m.id
  LEFT JOIN "ResourceReview" rr ON rr."modelVersionId" = mv.id
  AND rr."userId" = i."userId";

-- Create PostResourceHelper View
CREATE
OR REPLACE VIEW "PostResourceHelper" AS
SELECT
  DISTINCT ON ("postId", "name", "modelVersionId") *
FROM
  "ImageResourceHelper";
