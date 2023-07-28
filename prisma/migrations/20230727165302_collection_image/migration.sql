-- AlterTable
ALTER TABLE "Collection" DROP COLUMN "coverImage",
ADD COLUMN     "imageId" INTEGER,
ADD COLUMN     "nsfw" BOOLEAN DEFAULT false;

-- CreateTable
CREATE TABLE "CollectionReport" (
    "collectionId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,

    CONSTRAINT "CollectionReport_pkey" PRIMARY KEY ("reportId","collectionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionReport_reportId_key" ON "CollectionReport"("reportId");

-- CreateIndex
CREATE INDEX "Collection_userId_idx" ON "Collection"("userId");

-- AddForeignKey
ALTER TABLE "CollectionReport" ADD CONSTRAINT "CollectionReport_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionReport" ADD CONSTRAINT "CollectionReport_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;
