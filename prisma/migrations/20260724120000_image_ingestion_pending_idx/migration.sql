-- Partial index backing the image-ingestion Prometheus gauges
-- (image_ingestion_backlog / image_ingestion_oldest_age_seconds).
--
-- The Image table is enormous and dominated by 'Scanned' rows, so an unfiltered
-- GROUP BY over "ingestion" would seq-scan the whole table. The gauge query is
-- scoped to the four non-terminal working states and its WHERE clause matches this
-- index predicate EXACTLY, so both COUNT(*) and per-status MIN("createdAt") are
-- served from this (small) partial index instead of the heap.
--
-- Apply MANUALLY (we do not run `prisma migrate deploy`). CREATE INDEX CONCURRENTLY
-- must run OUTSIDE a transaction — run this statement on its own, not wrapped in a
-- BEGIN/COMMIT block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_ingestion_pending_idx"
  ON "Image" ("ingestion", "createdAt")
  WHERE "ingestion" IN ('Pending', 'Error', 'Rescan', 'PendingManualAssignment');
