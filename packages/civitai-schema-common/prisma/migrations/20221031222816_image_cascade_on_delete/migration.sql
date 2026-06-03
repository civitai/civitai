-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_imageId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnReviews" DROP CONSTRAINT "ImagesOnReviews_imageId_fkey";

-- AddForeignKey
ALTER TABLE "ImagesOnModels" ADD CONSTRAINT "ImagesOnModels_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnReviews" ADD CONSTRAINT "ImagesOnReviews_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;
