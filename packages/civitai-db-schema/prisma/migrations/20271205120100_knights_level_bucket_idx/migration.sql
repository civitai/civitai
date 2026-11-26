-- Serves the play feed's per-bucket reads (`stageWindow` in apps/knights/src/lib/server/queue/queue.service.ts): one
-- stage, one bucket (or the NULL fallback), one priority, oldest first, after a ("createdAt", id) cursor. Partial on the
-- rows the feed serves, so Prisma cannot express it and schema.full.prisma does not list it. Its own file:
-- CONCURRENTLY cannot run inside a transaction.
--
-- Apply by hand after 20271205120000_knights_level_bucket and before the Knights release that reads the column. Skip the
-- usual BEGIN ... ROLLBACK dry run: CONCURRENTLY cannot run inside a transaction block. Run the statement on its own,
-- then check pg_index.indisvalid. A cancelled build leaves an invalid index under its name, which IF NOT EXISTS then
-- skips; if indisvalid is false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KnightsQueueItem_open_levelBucket_idx"
  ON "KnightsQueueItem" ("minRank", "levelBucket", "priority", "createdAt", "id")
  WHERE "status" = 'Open' AND "audience" IS NULL AND NOT "isHiddenCheck";
