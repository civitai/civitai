-- CreateEnum
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "blockedFor" TEXT,
ADD COLUMN     "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Pending';

UPDATE "Image"
SET "ingestion" = 'Scanned'
WHERE "scannedAt" IS NOT NULL