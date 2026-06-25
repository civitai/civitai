/*
  Warnings:

  - Added the required column `status` to the `ModelReport` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Valid', 'Invalid');

-- AlterEnum
ALTER TYPE "ModelStatus" ADD VALUE 'GatherInterest';

-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'Ownership';

-- AlterTable
ALTER TABLE "ModelReport" ADD COLUMN     "details" JSONB,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ReportStatus";

UPDATE "ModelReport" SET "status" = 'Valid';

ALTER TABLE "ModelReport" ALTER COLUMN "status" SET NOT NULL;

-- CreateTable
CREATE TABLE "ModelInterest" (
    "userId" INTEGER NOT NULL,
    "modelId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelInterest_pkey" PRIMARY KEY ("userId","modelId")
);

-- AddForeignKey
ALTER TABLE "ModelInterest" ADD CONSTRAINT "ModelInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelInterest" ADD CONSTRAINT "ModelInterest_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
