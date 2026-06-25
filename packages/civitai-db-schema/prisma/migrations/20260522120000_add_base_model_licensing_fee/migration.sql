-- CreateTable
CREATE TABLE "BaseModelLicensingFee" (
    "baseModel" TEXT NOT NULL,
    "modelType" "ModelType" NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaseModelLicensingFee_pkey" PRIMARY KEY ("baseModel", "modelType")
);

-- CreateIndex
CREATE INDEX "BaseModelLicensingFee_modelVersionId_idx" ON "BaseModelLicensingFee"("modelVersionId");

-- AddForeignKey
ALTER TABLE "BaseModelLicensingFee" ADD CONSTRAINT "BaseModelLicensingFee_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: Anima checkpoint base model fee recipient (skipped if version absent, e.g. on staging/dev)
INSERT INTO "BaseModelLicensingFee" ("baseModel", "modelType", "modelVersionId", "updatedAt")
SELECT 'Anima', 'Checkpoint', 2945208, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "ModelVersion" WHERE id = 2945208)
ON CONFLICT ("baseModel", "modelType") DO NOTHING;
