-- Idempotent: applied by hand, possibly more than once.
--
-- What a buyer downloads, and per-image results that outlive a deleted file. Apply BEFORE
-- deploying: the jobs and the download route read these columns unconditionally.

ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "deliveryKey" TEXT;
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "deliverySize" INTEGER;
ALTER TABLE "ServiceDealFile" ADD COLUMN IF NOT EXISTS "repackedAt" TIMESTAMP(3);

-- A per-image result keeps its deal, so it can be judged after its file is gone.
ALTER TABLE "ServiceDealFileEntry" ADD COLUMN IF NOT EXISTS "dealId" INTEGER;
UPDATE "ServiceDealFileEntry" e SET "dealId" = f."dealId"
  FROM "ServiceDealFile" f WHERE f."id" = e."fileId" AND e."dealId" IS NULL;
ALTER TABLE "ServiceDealFileEntry" ALTER COLUMN "dealId" SET NOT NULL;

ALTER TABLE "ServiceDealFileEntry" ALTER COLUMN "fileId" DROP NOT NULL;
ALTER TABLE "ServiceDealFileEntry" DROP CONSTRAINT IF EXISTS "ServiceDealFileEntry_fileId_fkey";
ALTER TABLE "ServiceDealFileEntry"
  ADD CONSTRAINT "ServiceDealFileEntry_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "ServiceDealFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ServiceDealFile_repack_idx"
  ON "ServiceDealFile" ("id") WHERE "kind" = 'Final' AND "unpackedAt" IS NOT NULL AND "repackedAt" IS NULL;
