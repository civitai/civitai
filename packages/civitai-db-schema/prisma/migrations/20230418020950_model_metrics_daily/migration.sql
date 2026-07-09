-- CreateTable
CREATE TABLE "ModelMetricDaily" (
    "modelId" INTEGER NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ModelMetricDaily_pkey" PRIMARY KEY ("modelId","modelVersionId","type","date")
);

-- CreateIndex
CREATE INDEX "ModelMetricDaily_modelVersionId_idx" ON "ModelMetricDaily"("modelVersionId");

-- AddForeignKey
ALTER TABLE "ModelMetricDaily" ADD CONSTRAINT "ModelMetricDaily_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelMetricDaily" ADD CONSTRAINT "ModelMetricDaily_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
