-- ============================================================
-- App Blocks — author analytics (Phase 0) supporting index
-- ============================================================
-- The author analytics dashboard's installs time-series groups
-- block_user_subscriptions by (app_block_id, created_at) for the apps the
-- caller owns. The existing indexes on this table are either partial
-- (scope='publisher_all_my_models' / 'viewer_personal') or keyed on
-- (user_id, ...) — none serve an "installs over time for THIS app" scan.
--
-- This composite index makes that bounded: the dashboard always filters by
-- a small set of owned app_block ids + a clamped date range. Cheap to add
-- (the analytics read path is dark behind the appBlocks flag).
--
-- ⚠️ MANUAL APPLY: CNPG nvme0 (main civitai DB) does NOT auto-apply Prisma
-- migrations. Apply this by hand per environment. On prod prefer:
--   CREATE INDEX CONCURRENTLY "bus_app_block_created_idx"
--     ON "block_user_subscriptions" ("app_block_id", "created_at" DESC);
-- (CONCURRENTLY can't run inside Prisma's migration transaction, hence the
-- plain form below for the migration history; run the CONCURRENTLY variant
-- against prod to avoid a write lock.)

CREATE INDEX IF NOT EXISTS "bus_app_block_created_idx"
  ON "block_user_subscriptions" ("app_block_id", "created_at" DESC);
