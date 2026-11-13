-- Idempotent: applied by hand, possibly more than once.
--
-- Upload and preview-processing state for ServiceDealFile. The table is empty until the
-- creatorServices flag goes on, so the NOT NULL defaults rewrite nothing. Apply BEFORE deploying:
-- the delivery routes read these columns unconditionally.

DO $$ BEGIN
  CREATE TYPE "ServiceDealFileStatus" AS ENUM ('Uploading', 'Processing', 'Ready', 'Failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "fileName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "status" "ServiceDealFileStatus" NOT NULL DEFAULT 'Uploading';
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "failReason" TEXT;
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "uploadedAt" TIMESTAMP(3);
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "processingAt" TIMESTAMP(3);
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "scanKey" TEXT;
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "nsfwLevel" INTEGER;

-- An object key is owned by exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealFile_s3Key_key" ON "ServiceDealFile" ("s3Key");

-- The processing sweep: previews still on their way to Ready, and nothing else.
CREATE INDEX IF NOT EXISTS "ServiceDealFile_processing_idx"
  ON "ServiceDealFile" ("processingAt") WHERE "status" = 'Processing';

-- The scan sweep: finals whose scan has not finished.
CREATE INDEX IF NOT EXISTS "ServiceDealFile_pending_scan_idx"
  ON "ServiceDealFile" ("createdAt") WHERE "kind" = 'Final' AND "scanStatus" = 'Pending';

-- Scan copies waiting to be deleted: rows that still point at their hidden Image.
CREATE INDEX IF NOT EXISTS "ServiceDealFile_scan_copy_idx"
  ON "ServiceDealFile" ("id") WHERE "imageId" IS NOT NULL;
