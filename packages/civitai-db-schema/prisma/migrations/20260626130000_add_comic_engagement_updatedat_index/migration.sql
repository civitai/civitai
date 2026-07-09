-- Index for the `comicProjectMetrics` cron's incremental affected-comics scan
-- (`SELECT "projectId" FROM "ComicProjectEngagement" WHERE "updatedAt" > lastUpdate`),
-- which runs ~every minute. Without it that query is a full Seq Scan of the whole
-- table (measured: ~123K rows / 15.7ms to find ~5 recent rows) and the cost grows
-- linearly with engagement volume.
--
-- For prod, prefer the lock-free form (cannot run inside a transaction block):
--   CREATE INDEX CONCURRENTLY "ComicProjectEngagement_updatedAt_idx"
--     ON "ComicProjectEngagement"("updatedAt");
CREATE INDEX "ComicProjectEngagement_updatedAt_idx" ON "ComicProjectEngagement"("updatedAt");
