-- Recently banned accounts, read every 15 minutes by the `revoke-user-tokens` job. Without the index
-- that is a seq scan of "User". Partial: only banned rows are indexed.
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the job is correct without it, only slow.
--
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "User_bannedAt_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_bannedAt_idx"
  ON "User" ("bannedAt")
  WHERE "bannedAt" IS NOT NULL;
