/*
  Warnings:

  - A unique constraint covering the columns `[collectionId,articleId,postId,imageId,modelId]` on the table `CollectionItem` will be added. If there are existing duplicate values, this will fail.
*/
-- CreateEnum
CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');

-- AlterEnum
ALTER TYPE "CollectionContributorPermission" ADD VALUE 'ADD_REVIEW';

-- DropIndex
DROP INDEX "CollectionItem_collectionId_addedById_articleId_postId_imag_key";

-- AlterTable
ALTER TABLE "CollectionItem" ADD COLUMN     "status" "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED';

-- CreateTable
CREATE TABLE "TagsOnCollection" (
    "collectionId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnCollection_pkey" PRIMARY KEY ("tagId","collectionId")
);

-- CreateIndex
CREATE INDEX "TagsOnCollection_collectionId_idx" ON "TagsOnCollection" USING HASH ("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionItem_collectionId_articleId_postId_imageId_modelI_key" ON "CollectionItem"("collectionId", "articleId", "postId", "imageId", "modelId");

-- AddForeignKey
ALTER TABLE "TagsOnCollection" ADD CONSTRAINT "TagsOnCollection_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnCollection" ADD CONSTRAINT "TagsOnCollection_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
