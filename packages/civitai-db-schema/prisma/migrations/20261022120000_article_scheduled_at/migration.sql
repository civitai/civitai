-- Article."scheduledAt": go-live time for a never-published Draft.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. A human applies this per
-- environment (dev, then prod) BEFORE the code that reads the column ships: the new client
-- selects "scheduledAt", so a deploy ahead of this migration fails every article read.
-- Additive and nullable, so the currently deployed client is unaffected.

ALTER TABLE "Article"
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);

-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). Partial: indexes only scheduled rows.
-- A failed build leaves an INVALID index: DROP INDEX IF EXISTS "Article_scheduledAt_idx", re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Article_scheduledAt_idx"
  ON "Article" ("scheduledAt")
  WHERE "scheduledAt" IS NOT NULL;
