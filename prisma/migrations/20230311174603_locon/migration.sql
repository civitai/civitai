-- AlterEnum
ALTER TYPE "ModelType"
ADD
  VALUE 'LoCon';

-- AlterTable
ALTER TABLE
  "Model"
ADD
  COLUMN "underAttack" BOOLEAN NOT NULL DEFAULT false;

-- Remove temp indexes
DROP INDEX IF EXISTS "TagsOnImage_imageId";

DROP INDEX IF EXISTS "TagsOnModels_modelId";

DROP INDEX IF EXISTS "TagsOnPost_postId";

DROP INDEX IF EXISTS "TagsOnQuestions_questionId";

DROP INDEX IF EXISTS "ModelEngagement_modelId";

DROP INDEX IF EXISTS "ImagesOnModels_modelVersionId";

DROP INDEX IF EXISTS "ImagesOnReviews_reviewId";

DROP INDEX IF EXISTS "Comment_modelId";

DROP INDEX IF EXISTS "Review_modelId";

DROP INDEX IF EXISTS "ModelVersion_modelId";

DROP INDEX IF EXISTS "ModelFile_modelVersionId";

DROP INDEX IF EXISTS "ModelFileHash_modelFileId";

DROP INDEX IF EXISTS "Image_featuredAt";

-- CreateIndex
CREATE INDEX "Comment_modelId_idx" ON "Comment" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "Comment_reviewId_idx" ON "Comment" USING HASH ("reviewId");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "Comment" USING HASH ("parentId");

-- CreateIndex
CREATE INDEX "CommentV2_threadId_idx" ON "CommentV2" USING HASH ("threadId");

-- CreateIndex
CREATE INDEX "Image_featuredAt_idx" ON "Image"("featuredAt");

-- CreateIndex
CREATE INDEX "Image_postId_idx" ON "Image" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "ImagesOnModels_modelVersionId_idx" ON "ImagesOnModels" USING HASH ("modelVersionId");

-- CreateIndex
CREATE INDEX "ImagesOnReviews_reviewId_idx" ON "ImagesOnReviews" USING HASH ("reviewId");

-- CreateIndex
CREATE INDEX "ModelEngagement_modelId_idx" ON "ModelEngagement" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "ModelFile_modelVersionId_idx" ON "ModelFile" USING HASH ("modelVersionId");

-- CreateIndex
CREATE INDEX "ModelVersion_modelId_idx" ON "ModelVersion" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "Review_modelId_idx" ON "Review" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "TagsOnImage_imageId_idx" ON "TagsOnImage" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "TagsOnModels_modelId_idx" ON "TagsOnModels" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "TagsOnPost_postId_idx" ON "TagsOnPost" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "TagsOnQuestions_questionId_idx" ON "TagsOnQuestions" USING HASH ("questionId");