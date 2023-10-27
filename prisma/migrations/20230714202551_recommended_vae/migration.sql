
-- AlterTable
ALTER TABLE "ModelVersion" ADD COLUMN     "vaeId" INTEGER;

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_vaeId_fkey" FOREIGN KEY ("vaeId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
