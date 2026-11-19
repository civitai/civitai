-- The models search-index delta scan (prepareModelsBatches) runs every 15 minutes and filters
-- "Model" on both timestamps: the bounds query on "createdAt", the page query on "updatedAt". With
-- no index on either, the bounds query walks the primary key from the oldest id looking for a recent
-- row, and the page query seq-scans the table.
--
-- "updatedAt" changes on every Prisma update, so its index stops those updates being HOT. That
-- costs more index writes on each Model update; "createdAt" never changes and costs nothing there.
--
-- Apply by hand, in any order relative to the deploy: no code depends on these indexes.
--
-- CONCURRENTLY cannot run inside a transaction, so run each statement on its own: one per
-- `psql -c` string, without -1 (two statements in one string run as one transaction). A cancelled
-- build leaves an invalid index under its name, which IF NOT EXISTS then skips. After applying, check
-- pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run the statement again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_createdAt_idx" ON "Model" ("createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_updatedAt_id_idx" ON "Model" ("updatedAt", id);
