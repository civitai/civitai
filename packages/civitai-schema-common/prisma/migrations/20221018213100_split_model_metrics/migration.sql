/*
  Warnings:

  - The primary key for the `ModelMetric` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `ModelMetric` table. All the data in the column will be lost.
  - You are about to drop the column `modelVersionId` on the `ModelMetric` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ModelMetric" DROP CONSTRAINT "ModelMetric_modelVersionId_fkey";

-- DropIndex
DROP INDEX "model_metric_unique";

-- AlterTable
ALTER TABLE "ModelMetric" DROP CONSTRAINT "ModelMetric_pkey",
DROP COLUMN "id",
DROP COLUMN "modelVersionId",
ADD CONSTRAINT "ModelMetric_pkey" PRIMARY KEY ("modelId", "timeframe");

-- CreateTable
CREATE TABLE "ModelVersionMetric" (
    "modelVersionId" INTEGER NOT NULL,
    "timeframe" "MetricTimeframe" NOT NULL,
    "rating" INTEGER NOT NULL,
    "ratingCount" INTEGER NOT NULL,
    "downloadCount" INTEGER NOT NULL,

    CONSTRAINT "ModelVersionMetric_pkey" PRIMARY KEY ("modelVersionId","timeframe")
);

-- AddForeignKey
ALTER TABLE "ModelVersionMetric" ADD CONSTRAINT "ModelVersionMetric_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
