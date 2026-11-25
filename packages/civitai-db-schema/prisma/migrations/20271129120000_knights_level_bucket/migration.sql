-- "KnightsQueueItem"."levelBucket": the level flag of a rating item's feed bucket (1, 2, 4, 8 or 16; 0 for none; NULL
-- until first set), stored so the play feed can seek to one bucket instead of reading a stage in age order. The value is
-- `bucketLevelSql` (apps/knights/src/lib/server/queue/queue.service.ts): `prediction.value` when it names a level, else
-- the image's level. The Knights tick (`syncLevelBuckets`) fills NULL values and corrects drifted ones; no producer
-- writes it.
--
-- Apply MANUALLY, per environment, BEFORE the Knights release that reads the column, in this order:
--   1. this file (instant: a nullable column without a default rewrites nothing);
--   2. 20271129120100_knights_level_bucket_idx (CREATE INDEX CONCURRENTLY, its own file);
--   3. 20271129120200_knights_level_bucket_backfill, repeated until it updates 0 rows.
-- Run `SET lock_timeout = '3s';` in the same session before the ALTER TABLE, and retry if it times out: the ADD COLUMN
-- takes a brief exclusive lock, and waiting behind a long read would queue the live feed behind it.
-- The knights_app role already holds UPDATE on the table, which covers the new column: no grant is needed.

ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "levelBucket" SMALLINT;
