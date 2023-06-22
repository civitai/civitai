-- CreateEnum
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "blockedFor" TEXT,
ADD COLUMN     "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Pending';

UPDATE "Image"
SET "ingestion" = 'Scanned'
WHERE "scannedAt" IS NOT NULL;

UPDATE "Image" i SET "scannedAt" = null, "ingestion" = 'Pending'
WHERE NOT EXISTS (SELECT 1 FROM "TagsOnImage" WHERE automated AND "imageId" = i.id)
AND "scanRequestedAt" IS NOT NULL;