-- ============================================================
-- App Blocks: when an app's stored data became eligible for deletion, and when it was deleted
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- ORDER RELATIVE TO THE CODE IS FREE. Both columns are marked no-type in `schema.full.prisma`, so
-- the generated Prisma client never names them; every read and write is raw SQL in
-- `src/server/jobs/reap-deleted-app-storage.ts`. Until this is applied that job's read fails with
-- 42703 (undefined column), which it logs and retries on its next run, deleting nothing.
--
--   storage_deleted_at — when the app was deleted. The reaper deletes the app's document-store
--     data (every user, every namespace) once this is 30 days old, and only while the block is
--     still not approved. Restoring the app clears it.
--   storage_purged_at  — when the reaper finished deleting that data. A deletion newer than it
--     (storage_deleted_at > storage_purged_at) makes the app eligible again.
--
-- ADDITIVE ONLY: two nullable columns (catalog-only on PG 11+, no table rewrite) and one partial
-- index over the rows that have a deletion, which is what the reaper reads. Idempotent.
--
-- LOCKS: each ADD COLUMN takes a brief ACCESS EXCLUSIVE lock on `app_blocks`; apply in autocommit
-- (plain `psql -f`), off-peak. The index is built CONCURRENTLY, so it must not run inside a
-- transaction block.

SET lock_timeout = '3s';

ALTER TABLE app_blocks ADD COLUMN IF NOT EXISTS storage_deleted_at timestamptz;
ALTER TABLE app_blocks ADD COLUMN IF NOT EXISTS storage_purged_at timestamptz;

CREATE INDEX CONCURRENTLY IF NOT EXISTS app_blocks_storage_deleted_at_idx
  ON app_blocks (storage_deleted_at)
  WHERE storage_deleted_at IS NOT NULL;
