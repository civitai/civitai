/*
  Warnings:

  - You are about to drop the column `sizeKB` on the `ModelVersion` table. All the data in the column will be lost.
  - You are about to drop the column `trainingDataUrl` on the `ModelVersion` table. All the data in the column will be lost.
  - You are about to drop the column `url` on the `ModelVersion` table. All the data in the column will be lost.
  - You are about to drop the column `verificationMessage` on the `ModelVersion` table. All the data in the column will be lost.
  - You are about to drop the column `verified` on the `ModelVersion` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ScanResultCode" AS ENUM ('Pending', 'Success', 'Danger', 'Error');

-- CreateEnum
CREATE TYPE "ModelFileType" AS ENUM ('Model', 'TrainingData');

-- CreateTable
CREATE TABLE "ModelFile" (
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeKB" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "ModelFileType" NOT NULL,
    "modelVersionId" INTEGER NOT NULL,
    "pickleScanResult" "ScanResultCode" NOT NULL DEFAULT 'Pending',
    "pickleScanMessage" TEXT,
    "virusScanResult" "ScanResultCode" NOT NULL DEFAULT 'Pending',
    "virusScanMessage" TEXT,
    "scannedAt" TIMESTAMP(3),
    "rawScanResult" JSONB,

    CONSTRAINT "ModelFile_pkey" PRIMARY KEY ("modelVersionId","type")
);

-- AddForeignKey
ALTER TABLE "ModelFile" ADD CONSTRAINT "ModelFile_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Move Model Files
INSERT INTO "ModelFile" ("name", "url", "sizeKB", "createdAt", "type", "modelVersionId")
SELECT regexp_replace("url", '^.+[/\\]', ''), "url", "sizeKB", "createdAt", 'Model'::"ModelFileType", "id" FROM "ModelVersion";

-- Move Training Files
INSERT INTO "ModelFile" ("name", "url", "sizeKB", "createdAt", "type", "modelVersionId")
SELECT regexp_replace("trainingDataUrl", '^.+[/\\]', ''), "trainingDataUrl", 0, "createdAt", 'TrainingData'::"ModelFileType", "id" FROM "ModelVersion"
WHERE "trainingDataUrl" IS NOT NULL;

-- AlterTable
ALTER TABLE "ModelVersion" DROP COLUMN "sizeKB",
DROP COLUMN "trainingDataUrl",
DROP COLUMN "url",
DROP COLUMN "verificationMessage",
DROP COLUMN "verified";