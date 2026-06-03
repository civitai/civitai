-- CreateEnum
CREATE TYPE "GenerationSchedulers" AS ENUM ('EulerA', 'Euler', 'LMS', 'Heun', 'DPM2', 'DPM2A', 'DPM2SA', 'DPM2M', 'DPMSDE', 'DPMFast', 'DPMAdaptive', 'LMSKarras', 'DPM2Karras', 'DPM2AKarras', 'DPM2SAKarras', 'DPM2MKarras', 'DPMSDEKarras', 'DDIM');

-- CreateTable
CREATE TABLE "ModelVersionGenerationCoverage" (
    "modelVersionId" INTEGER NOT NULL,
    "workers" INTEGER NOT NULL,
    "serviceProviders" TEXT[],

    CONSTRAINT "ModelVersionGenerationCoverage_pkey" PRIMARY KEY ("modelVersionId")
);

-- CreateTable
CREATE TABLE "GenerationServiceProvider" (
    "name" TEXT NOT NULL,
    "schedulers" "GenerationSchedulers"[],

    CONSTRAINT "GenerationServiceProvider_pkey" PRIMARY KEY ("name")
);

-- AddForeignKey
ALTER TABLE "ModelVersionGenerationCoverage" ADD CONSTRAINT "ModelVersionGenerationCoverage_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
