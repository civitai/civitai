-- AlterEnum
ALTER TYPE "TagTarget" ADD VALUE 'Image';

-- CreateTable
CREATE TABLE "ImageReport" (
    "imageId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "TagsOnImage" (
    "imageId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnImage_pkey" PRIMARY KEY ("tagId","imageId")
);

-- CreateTable
CREATE TABLE "ImageComment" (
    "imageId" INTEGER NOT NULL,
    "commentId" INTEGER NOT NULL,

    CONSTRAINT "ImageComment_pkey" PRIMARY KEY ("imageId","commentId")
);

-- CreateTable
CREATE TABLE "ImageReaction" (
    "id" SERIAL NOT NULL,
    "imageId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageReport_reportId_key" ON "ImageReport"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageComment_commentId_key" ON "ImageComment"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageReaction_imageId_userId_reaction_key" ON "ImageReaction"("imageId", "userId", "reaction");

-- AddForeignKey
ALTER TABLE "ImageReport" ADD CONSTRAINT "ImageReport_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReport" ADD CONSTRAINT "ImageReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImage" ADD CONSTRAINT "TagsOnImage_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnImage" ADD CONSTRAINT "TagsOnImage_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageComment" ADD CONSTRAINT "ImageComment_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageComment" ADD CONSTRAINT "ImageComment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReaction" ADD CONSTRAINT "ImageReaction_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageReaction" ADD CONSTRAINT "ImageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- View: "ImageConnection"
CREATE OR REPLACE VIEW "ImageConnection" AS
SELECT
  i.id "imageId",
  i."userId",
  COALESCE(iom."modelVersionId", r."modelVersionId") "modelVersionId",
  COALESCE(mv."modelId",r."modelId") "modelId",
	ior."reviewId",
    COALESCE(ior.index, iom.index) "index"
FROM "Image" i
LEFT JOIN "ImagesOnModels" iom ON i.id = iom."imageId"
LEFT JOIN "ModelVersion" mv ON mv.id = iom."modelVersionId"
LEFT JOIN "ImagesOnReviews" ior ON i.id = ior."imageId"
LEFT JOIN "Review" r ON ior."reviewId" = r.id;