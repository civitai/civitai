-- CreateEnum
CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');

-- AlterTable
ALTER TABLE "Article"
  ADD COLUMN "ingestion" "ArticleIngestionStatus" NOT NULL DEFAULT 'Pending',
  ADD COLUMN "scanRequestedAt" TIMESTAMP(3);

-- CreateIndex
-- When running in production remember to use CONCURRENTLY to avoid locking the table for a long time
CREATE INDEX "Article_status_ingestion_nsfwLevel_idx"
  ON "Article" ("status", "ingestion", "nsfwLevel");
