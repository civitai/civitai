-- Video Finals: the held object version a scan copy was made from, checked at every download.
ALTER TABLE "ServiceDealFile" ADD COLUMN "scannedEtag" TEXT;
ALTER TABLE "ServiceDealFile" ADD COLUMN "scannedVersionId" TEXT;
