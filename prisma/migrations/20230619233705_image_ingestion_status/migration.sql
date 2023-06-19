-- CreateEnum
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked');

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "blockedFor" TEXT,
ADD COLUMN     "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Pending';

-- TODO.ingestion - set image ingestion statuses for all previous images