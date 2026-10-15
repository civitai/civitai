-- Idempotent: applied by hand, possibly more than once.
--
-- Per-image results for the contents of a delivered file. Apply BEFORE deploying: the unpack job
-- reads these columns unconditionally.

ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "malwareScanStatus" "ServiceDealFileScanStatus" NOT NULL DEFAULT 'Pending';
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "unpackedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ServiceDealFileEntry" (
  "id" SERIAL NOT NULL,
  "fileId" INTEGER NOT NULL,
  "entryIndex" INTEGER NOT NULL,
  "path" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "imageId" INTEGER,
  "scanKey" TEXT,
  "nsfwLevel" INTEGER,
  "scanStatus" "ServiceDealFileScanStatus" NOT NULL DEFAULT 'Pending',
  "failReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceDealFileEntry_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ServiceDealFileEntry"
    ADD CONSTRAINT "ServiceDealFileEntry_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "ServiceDealFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealFileEntry_fileId_entryIndex_key"
  ON "ServiceDealFileEntry" ("fileId", "entryIndex");

-- The unpack sweep: finals not yet unpacked.
CREATE INDEX IF NOT EXISTS "ServiceDealFile_unpack_idx"
  ON "ServiceDealFile" ("id") WHERE "kind" = 'Final' AND "unpackedAt" IS NULL AND "status" = 'Ready';

-- Scan copies waiting to be settled or deleted: entries that still point at their hidden Image.
CREATE INDEX IF NOT EXISTS "ServiceDealFileEntry_scan_copy_idx"
  ON "ServiceDealFileEntry" ("id") WHERE "imageId" IS NOT NULL OR "scanKey" IS NOT NULL;
