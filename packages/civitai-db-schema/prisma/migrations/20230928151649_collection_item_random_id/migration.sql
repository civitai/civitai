-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "CollectionItem" ADD COLUMN     "randomId" INTEGER;

-- CreateIndex
CREATE INDEX "CollectionItem_addedById_idx" ON "CollectionItem" USING HASH ("addedById");

-- CreateIndex
CREATE INDEX "CollectionItem_imageId_idx" ON "CollectionItem" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "CollectionItem_modelId_idx" ON "CollectionItem" USING HASH ("modelId");
