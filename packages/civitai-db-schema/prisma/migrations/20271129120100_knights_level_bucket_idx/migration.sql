-- Serves the play feed's per-bucket reads (`stageWindow` in apps/knights/src/lib/server/queue/queue.service.ts): one
-- stage, one bucket (or the NULL fallback), one priority, oldest first, after a ("createdAt", id) cursor. Partial on the
-- rows the feed serves, so Prisma cannot express it and schema.full.prisma does not list it. Its own file:
-- CONCURRENTLY cannot run inside a transaction.
--
-- Apply by hand after 20271129120000_knights_level_bucket and before the Knights release that reads the column. Run the
-- statement on its own. A cancelled build leaves an invalid index under its name, which IF NOT EXISTS then skips. After
-- applying, check pg_index.indisvalid; if false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KnightsQueueItem_open_levelBucket_idx"
  ON "KnightsQueueItem" ("minRank", "levelBucket", "priority", "createdAt", "id")
  WHERE "status" = 'Open' AND "audience" IS NULL AND NOT "isHiddenCheck";
