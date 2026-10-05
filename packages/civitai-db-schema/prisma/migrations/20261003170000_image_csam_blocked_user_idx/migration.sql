-- The relabel batch's CSAM exclusion asks, per candidate, whether the owner has any image blocked
-- for CSAM. Without this, that walks every image of the owner. Apply BEFORE the relabel-build-batch
-- job deploys. CONCURRENTLY: run outside a transaction.
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid, and if false, DROP INDEX CONCURRENTLY and run this again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_csam_blocked_userId_idx"
  ON "Image" ("userId")
  WHERE "blockedFor" = 'CSAM';
