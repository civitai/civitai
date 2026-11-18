-- Deal-file retention: the record of a purged deal file.
CREATE TABLE "ServiceDealFilePurge" (
  "id" SERIAL NOT NULL,
  "fileId" INTEGER NOT NULL,
  "dealId" INTEGER NOT NULL,
  "size" INTEGER NOT NULL,
  "etag" TEXT,
  "purgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceDealFilePurge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceDealFilePurge_fileId_key" ON "ServiceDealFilePurge"("fileId");
CREATE INDEX "ServiceDealFilePurge_dealId_idx" ON "ServiceDealFilePurge"("dealId");
