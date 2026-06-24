-- ============================================================
-- App Blocks — block_user_subscriptions(user_id) supporting index
-- ============================================================
-- blocks.getNavSummary does an install existence check scoped to the caller:
--   SELECT 1 FROM block_user_subscriptions WHERE user_id = $1 LIMIT 1
-- This runs on every /apps/* render for mods today (and broadly at GA). The
-- table's only index is bus_app_block_created_idx on (app_block_id, created_at)
-- — it does NOT serve a user_id lookup, so the existence check is an unindexed
-- scan. This single-column index makes it an index-only LIMIT 1.
--
-- ⚠️ MANUAL APPLY: CNPG nvme0 (main civitai DB) does NOT auto-apply Prisma
-- migrations. Apply this by hand per environment. On prod prefer:
--   CREATE INDEX CONCURRENTLY "bus_user_id_idx"
--     ON "block_user_subscriptions" ("user_id");
-- (CONCURRENTLY can't run inside Prisma's migration transaction, hence the
-- plain form below for the migration history; run the CONCURRENTLY variant
-- against prod — outside any explicit transaction — to avoid a write lock.)

CREATE INDEX IF NOT EXISTS "bus_user_id_idx"
  ON "block_user_subscriptions" ("user_id");
