-- ============================================================
-- F-E E3 — App Blocks marketplace browse metadata
-- ============================================================
-- See claudedocs/app-platform-fe-marketplace-plan-2026-06-14.md (Phase E3,
-- design decisions #1/#4/#5).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations. This file is committed for
-- history; a HUMAN applies the SQL below per environment (psql/retool). CI /
-- deploy does NOT run it.
--
-- ADDITIVE + NON-BREAKING:
--   - All three columns are nullable OR have a DEFAULT, so existing rows and
--     existing INSERTs (which don't mention these columns) are unaffected.
--   - No existing query selects these columns; the only reader is the
--     mod-gated (dark) marketplace listing, which COALESCEs / tolerates NULL.
--   - `category` is FREE-TEXT (not an enum) so adding a category later needs
--     no migration — only the MARKETPLACE_CATEGORIES const changes.
--   - Indexes are created CONCURRENTLY-friendly small adds; safe to run online.

ALTER TABLE "app_blocks"
  ADD COLUMN IF NOT EXISTS "category"       TEXT,
  ADD COLUMN IF NOT EXISTS "featured"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "featured_order" INTEGER;

-- Browse filters: approved + category is the marketplace's hot filter path.
CREATE INDEX IF NOT EXISTS "app_blocks_status_category_idx"
  ON "app_blocks" ("status", "category");

-- E4 curation rail: featured apps ordered by featured_order.
CREATE INDEX IF NOT EXISTS "app_blocks_featured_order_idx"
  ON "app_blocks" ("featured", "featured_order");
