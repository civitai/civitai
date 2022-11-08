-- DropForeignKey
ALTER TABLE "ModelVersionMetric" DROP CONSTRAINT "ModelVersionMetric_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_modelVersionId_fkey";

-- AddForeignKey
ALTER TABLE "ModelVersionMetric" ADD CONSTRAINT "ModelVersionMetric_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
