-- An image delete by its owner first looks for a deal file entry pointing at the image. Without this
-- index each lookup scans ServiceDealFileEntry.
-- CONCURRENTLY, so run it on its own, outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ServiceDealFileEntry_imageId_idx"
  ON "ServiceDealFileEntry" ("imageId");
