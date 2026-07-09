-- DropForeignKey
ALTER TABLE "RunStrategy" DROP CONSTRAINT "RunStrategy_modelVersionId_fkey";

-- DropForeignKey
ALTER TABLE "RunStrategy" DROP CONSTRAINT "RunStrategy_partnerId_fkey";

-- AddForeignKey
ALTER TABLE "RunStrategy" ADD CONSTRAINT "RunStrategy_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStrategy" ADD CONSTRAINT "RunStrategy_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
