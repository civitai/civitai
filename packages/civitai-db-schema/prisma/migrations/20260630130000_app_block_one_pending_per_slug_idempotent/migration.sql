-- ============================================================
-- App Blocks — one-pending-per-slug partial unique index (idempotent re-assert)
-- ============================================================
-- The web manifest editor (`blocks.updateManifest`) calls
-- `recordPendingFromPush` explicitly AND the Forgejo push webhook the same
-- commit fires ALSO calls it for the same (slug, sha). Both can miss the
-- in-app "already captured this sha?" read and both attempt to INSERT a
-- `pending` publish-request row for the slug. The application now catches the
-- resulting unique-violation (P2002) and re-reads the winner's row, but that
-- catch is only correct if the partial unique index it relies on actually
-- exists in the target database.
--
-- That index was first created in
--   20260528170000_w1_publish_requests / 20260528210000_w1_uniqueness_constraints
-- (verified present on prod 2026-06-30). This migration re-asserts it
-- IDEMPOTENTLY so any environment whose history pre-dates that work (a dev DB
-- clone, a partially-applied env) cannot end up running the new P2002-catch
-- code path WITHOUT the DB constraint that makes it sound. Applying this on an
-- env that already has the index is a no-op.
--
-- Pre-flight (REQUIRED — index creation FAILS if duplicates already exist):
--   SELECT slug, count(*) FROM app_block_publish_requests
--     WHERE status='pending' GROUP BY slug HAVING count(*) > 1;
--   -- Must return 0 rows. Verified 0 on prod (cnpg-cluster-nvme0, db civitai)
--   -- 2026-06-30 before this migration was committed.
--   -- If it returns rows, resolve the duplicates first (withdraw the older
--   -- pending row(s) per slug) — otherwise the CREATE UNIQUE INDEX below errors.
--
-- Manual application (per CLAUDE.md Database rule #8 — NOT auto-applied by CI):
--   kubectl exec -i -n cnpg-database cnpg-cluster-nvme0-N -- psql \
--     -U postgres -d civitai -v ON_ERROR_STOP=1 --single-transaction \
--     < prisma/migrations/20260630130000_app_block_one_pending_per_slug_idempotent/migration.sql

CREATE UNIQUE INDEX IF NOT EXISTS "app_block_publish_requests_one_pending_per_slug"
  ON "app_block_publish_requests" ("slug")
  WHERE "status" = 'pending';
