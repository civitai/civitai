-- The remove-deleted-user-images job filters "User" on "deletedAt" IS NOT NULL
-- every run. Without this index that is a parallel seq scan over ~12.7M rows
-- (~1.7s, ~612K buffers). The partial index covers only the ~1.3M soft-deleted
-- rows and lets the job take the newest deletions first.
--
-- CONCURRENTLY cannot run inside a transaction block. Run this statement on its
-- own, not wrapped in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_deletedAt_idx"
  ON "User" ("deletedAt" DESC)
  WHERE "deletedAt" IS NOT NULL;
