-- DropIndex
DROP INDEX "ModelFile_modelVersionId_type_format_key";

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "postId" INTEGER;

-- CreateTable
CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "detail" TEXT,

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

-- CreateIndex
CREATE UNIQUE INDEX "ImageResource_modelVersionId_name_imageId_key" ON "ImageResource"("modelVersionId", "name", "imageId");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageResource" ADD CONSTRAINT "ImageResource_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageResource" ADD CONSTRAINT "ImageResource_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPost" ADD CONSTRAINT "TagsOnPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnPost" ADD CONSTRAINT "TagsOnPost_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
