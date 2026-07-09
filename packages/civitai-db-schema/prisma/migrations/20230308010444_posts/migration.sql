/*
  Warnings:

  - A unique constraint covering the columns `[postId]` on the table `Thread` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "TagTarget" ADD VALUE 'Post';

-- DropIndex
DROP INDEX "ModelFile_modelVersionId_type_format_key";

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "hideMeta" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "index" INTEGER,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "postId" INTEGER,
ADD COLUMN     "scanRequestedAt" TIMESTAMP(3),
ADD COLUMN     "scannedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "postId" INTEGER;

-- CreateTable
CREATE TABLE "ReviewV2" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "details" TEXT NOT NULL,
    "threadId" INTEGER,

    CONSTRAINT "ReviewV2_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "detail" TEXT,
    "userId" INTEGER NOT NULL,
    "modelVersionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageResource" (
    "id" SERIAL NOT NULL,
    "modelVersionId" INTEGER,
    "name" TEXT,
    "imageId" INTEGER NOT NULL,
    "detected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ImageResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagsOnPost" (
    "postId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnPost_pkey" PRIMARY KEY ("tagId","postId")
);

-- CreateTable
CREATE TABLE "PostReaction" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageResource_modelVersionId_name_imageId_key" ON "ImageResource"("modelVersionId", "name", "imageId");

-- CreateIndex
CREATE UNIQUE INDEX "PostReaction_postId_userId_reaction_key" ON "PostReaction"("postId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_postId_key" ON "Thread"("postId");

-- AddForeignKey
ALTER TABLE "ReviewV2" ADD CONSTRAINT "ReviewV2_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewV2" ADD CONSTRAINT "ReviewV2_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageResource" ADD CONSTRAINT "ImageResource_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageResource" ADD CONSTRAINT "ImageResource_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPost" ADD CONSTRAINT "TagsOnPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPost" ADD CONSTRAINT "TagsOnPost_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReaction" ADD CONSTRAINT "PostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Custom
-- UPDATE "Tag" SET target = array_append(target, 'Post')
-- WHERE 'Image' = ANY(Target);


-- CREATE OR REPLACE VIEW "PostHelper" AS
-- SELECT
--     "postId",
--     MAX("scannedAt" IS NOT NULL) AS scanned
-- FROM "Image"
-- GROUP BY "postId";