-- AlterTable
ALTER TABLE "ModelMetric" ADD COLUMN     "generationCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ModelVersionMetric" ADD COLUMN     "generationCount" INTEGER NOT NULL DEFAULT 0;
