-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "modelAppId" INTEGER;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_modelAppId_fkey" FOREIGN KEY ("modelAppId") REFERENCES "ModelApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;
