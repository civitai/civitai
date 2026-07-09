-- AlterTable
ALTER TABLE "CollectionItem" ADD COLUMN     "tagId" INTEGER;
 
-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "TagTarget" ADD VALUE 'Collection';
