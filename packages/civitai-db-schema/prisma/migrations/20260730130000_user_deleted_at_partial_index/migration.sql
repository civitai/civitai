-- The remove-deleted-user-images job filters "User" on "deletedAt" IS NOT NULL
-- every run. Without this index that is a parallel seq scan over ~12.7M rows
-- (~1.7s, ~612K buffers). The partial index covers only the ~1.3M soft-deleted
-- rows and lets the job page through them newest-first.
--
-- Named "_notnull_" because "User_deletedAt_idx" is already taken (migration
-- 20250228013729_normalize renames the plain index into it) and IF NOT EXISTS
-- matches on name alone, never on definition — reusing the name would make this
-- a silent no-op wherever the plain index exists, leaving the job unindexed.
--
-- CONCURRENTLY cannot run inside a transaction block. Run this statement on its
-- own, not wrapped in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_deletedAt_notnull_idx"
  ON "User" ("deletedAt" DESC)
  WHERE "deletedAt" IS NOT NULL;
