-- CreateEnum
CREATE TYPE "MetricSnapshotType" AS ENUM ('ModelDownload');

-- CreateTable
CREATE TABLE "ModelMetricDailySummary" (
    "modelId" INTEGER NOT NULL,
    "type" "MetricSnapshotType" NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ModelMetricDailySummary_pkey" PRIMARY KEY ("modelId","type","date")
);

-- CreateTable
CREATE TABLE "ModelVersionMetricDailySummary" (
    "modelVersionId" INTEGER NOT NULL,
    "type" "MetricSnapshotType" NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ModelVersionMetricDailySummary_pkey" PRIMARY KEY ("modelVersionId","type","date")
);

-- AddForeignKey
ALTER TABLE "ModelMetricDailySummary" ADD CONSTRAINT "ModelMetricDailySummary_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersionMetricDailySummary" ADD CONSTRAINT "ModelVersionMetricDailySummary_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
