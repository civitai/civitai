-- ============================================================
-- Scheduled articles — Article."scheduledAt"
-- ============================================================
-- A Draft with "scheduledAt" set goes live at that time: process-scheduled-publishing flips it
-- to Published (or Processing while its scan is pending) and stamps "publishedAt". Until then
-- "publishedAt" stays NULL, so the article is hidden by the same rules that hide any draft.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. A human applies this per
-- environment (dev, then prod) BEFORE the code that reads the column ships: the new client
-- selects "scheduledAt", so a deploy ahead of this migration fails every article read.
-- Additive and nullable, so the currently deployed client is unaffected.
-- Idempotent: IF NOT EXISTS on the column and the index.

ALTER TABLE "Article"
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);

-- RUN OUTSIDE ANY TRANSACTION. Partial: only the handful of scheduled rows are indexed, and the
-- per-minute job's "scheduledAt" <= now() range scan reads only those.
-- If it fails mid-build it leaves an INVALID index: DROP INDEX IF EXISTS "Article_scheduledAt_idx"
-- and re-run it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Article_scheduledAt_idx"
  ON "Article" ("scheduledAt")
  WHERE "scheduledAt" IS NOT NULL;
