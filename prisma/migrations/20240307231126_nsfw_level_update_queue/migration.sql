

UPDATE "Article" a
SET "coverId" = null
WHERE NOT EXISTS(
	SELECT i.id from "Image" i WHERE i.id = a."coverId"
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_coverId_key" ON "Article"("coverId");

-- AddForeignKey
ALTER TABLE "Article"
  ADD CONSTRAINT "Article_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "Image"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Article', 'Bounty', 'BountyEntry', 'ModelVersion', 'Model', 'Collection');

-- CreateEnum
CREATE TYPE "JobQueueType" AS ENUM ('CleanUp', 'UpdateMetrics', 'UpdateNsfwLevel', 'UpdateSearchIndex', 'CleanIfEmpty');

-- CreateTable
CREATE TABLE "JobQueue" (
    "type" "JobQueueType" NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("entityType","entityId","type")
);

ALTER TABLE "CollectionItem"
	DROP CONSTRAINT "CollectionItem_articleId_fkey",
	DROP CONSTRAINT "CollectionItem_imageId_fkey",
	DROP CONSTRAINT "CollectionItem_postId_fkey",
	DROP CONSTRAINT "CollectionItem_modelId_fkey";

ALTER TABLE "ImageConnection"
	DROP CONSTRAINT	"ImageConnection_imageId_fkey";
