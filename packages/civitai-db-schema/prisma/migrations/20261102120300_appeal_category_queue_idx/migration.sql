-- The moderator app's per-category appeal queues: one category, one status, oldest first. Partial,
-- so it covers only form appeals and stays small beside the image appeals.
--
-- Apply after 20261102120200_appeal_category_pending_key. Additive; the queues are correct without
-- it, only slow.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Appeal_category_status_createdAt_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Appeal_category_status_createdAt_idx"
  ON "Appeal" (category, status, "createdAt", id)
  WHERE category IS NOT NULL;
