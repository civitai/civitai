-- Deal files the hold rules keep after a delete or a refused upload. Applied by hand, BEFORE the
-- deploy that writes to it. Additive: a new table, no backfill, no foreign keys.
CREATE TABLE IF NOT EXISTS "ServiceDealFileHeld" (
  "id" SERIAL PRIMARY KEY,
  "fileId" INTEGER NOT NULL,
  "dealId" INTEGER NOT NULL,
  "uploaderId" INTEGER NOT NULL,
  "kind" "ServiceDealFileKind" NOT NULL,
  "round" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "s3Key" TEXT,
  "deliveryKey" TEXT,
  "imageId" INTEGER,
  "entryIds" INTEGER[] NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL,
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceDealFileHeld_fileId_key" ON "ServiceDealFileHeld"("fileId");
CREATE INDEX IF NOT EXISTS "ServiceDealFileHeld_dealId_idx" ON "ServiceDealFileHeld"("dealId");
CREATE INDEX IF NOT EXISTS "ServiceDealFileHeld_uploaderId_idx" ON "ServiceDealFileHeld"("uploaderId");
