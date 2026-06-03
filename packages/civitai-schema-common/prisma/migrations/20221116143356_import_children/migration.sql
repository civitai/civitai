-- DropIndex
DROP INDEX "ModelVersion_fromImportId_key";

-- AlterTable
ALTER TABLE "Import" ADD COLUMN     "importId" INTEGER,
ADD COLUMN     "parentId" INTEGER;

-- AddForeignKey
ALTER TABLE "Import" ADD CONSTRAINT "Import_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Import"("id") ON DELETE SET NULL ON UPDATE CASCADE;
