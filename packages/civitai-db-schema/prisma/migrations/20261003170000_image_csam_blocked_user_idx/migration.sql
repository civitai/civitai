-- The relabel batch's CSAM exclusion asks, per candidate, whether the owner has any image blocked
-- for CSAM. Without this, that walks every image of the owner. Apply BEFORE the relabel-build-batch
-- job deploys. CONCURRENTLY: run outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_csam_blocked_userId_idx"
  ON "Image" ("userId")
  WHERE "blockedFor" = 'CSAM';
