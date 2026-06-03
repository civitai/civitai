-- DropForeignKey
ALTER TABLE "ImagesOnModels" DROP CONSTRAINT "ImagesOnModels_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ImagesOnReviews" DROP CONSTRAINT "ImagesOnReviews_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ModelVersion" DROP CONSTRAINT "ModelVersion_modelId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_modelId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReaction" DROP CONSTRAINT "ReviewReaction_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "ReviewReaction" DROP CONSTRAINT "ReviewReaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "TagsOnModels" DROP CONSTRAINT "TagsOnModels_modelId_fkey";

-- DropForeignKey
ALTER TABLE "TagsOnModels" DROP CONSTRAINT "TagsOnModels_tagId_fkey";

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReaction" ADD CONSTRAINT "ReviewReaction_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReaction" ADD CONSTRAINT "ReviewReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnModels" ADD CONSTRAINT "ImagesOnModels_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImagesOnReviews" ADD CONSTRAINT "ImagesOnReviews_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnModels" ADD CONSTRAINT "TagsOnModels_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnModels" ADD CONSTRAINT "TagsOnModels_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
