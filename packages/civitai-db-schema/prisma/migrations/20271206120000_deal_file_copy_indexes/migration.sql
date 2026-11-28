-- Every image attach check and owner delete asks whether a deal file points at the image
-- (`dealFileImageSql`), by `imageId` or, for a copy whose pointer is not written yet, by `scanKey`.
-- ServiceDealFileEntry."imageId" is already indexed; these cover the other three probes.
--
-- Apply before the code that reads them deploys. CONCURRENTLY cannot run inside a transaction
-- block; run each statement on its own. An index left invalid: DROP INDEX CONCURRENTLY, re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ServiceDealFile_imageId_idx" ON "ServiceDealFile" ("imageId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ServiceDealFile_scanKey_idx"
  ON "ServiceDealFile" ("scanKey") WHERE "scanKey" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ServiceDealFileEntry_scanKey_idx"
  ON "ServiceDealFileEntry" ("scanKey") WHERE "scanKey" IS NOT NULL;
