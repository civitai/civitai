-- Serves the hub source picker's "models you asked to be notified about" read:
--   WHERE "userId" = $1 AND type = 'Notify' ORDER BY "createdAt" DESC LIMIT $2
--
-- Measured on the prod replica before this index: the heaviest account (250,491
-- Notify rows) reads ALL of them, ~130,800 buffers / ~1.02 GB touched, 283ms warm
-- and 1.56s cold, on every debounced keystroke. ModelEngagement_userId_type_modelId_idx
-- is (userId, type) INCLUDE (modelId), which cannot serve the ORDER BY, so the
-- planner heap-fetches every row and sorts. With this index the same read is an
-- index-only scan that stops at the window.
--
-- Partial on Notify, matching ModelEngagement_mute_userId_modelId_idx beside it:
-- the picker never reads the other types, and Notify is 43.1M of the table's 74.4M
-- rows. Prisma cannot express a partial index, so this one lives in SQL only — as
-- that Mute index already does.
--
-- CONCURRENTLY, because the table is 10 GB. Run it OUTSIDE a transaction: psql's
-- -c with two statements opens one implicitly and the server refuses. A cancelled
-- CONCURRENTLY build leaves an INVALID index that must be dropped before retrying.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelEngagement_notify_userId_createdAt_idx"
  ON "ModelEngagement" ("userId", "createdAt" DESC)
  INCLUDE ("modelId")
  WHERE type = 'Notify';
