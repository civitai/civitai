/*
  Warnings:

  - A unique constraint covering the columns `[imageId]` on the table `ImagesOnReviews` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ImagesOnReviews_imageId_key" ON "ImagesOnReviews"("imageId");
