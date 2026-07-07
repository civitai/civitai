-- ============================================================
-- App Store Listings (W13) — P3b: widen app_listings.status CHECK to add 'removed'
-- ============================================================
-- The mod delist action writes app_listings.status = 'removed'. The P0 CHECK
-- (20260701120000_w13_p0_app_listing/migration.sql) only allows
-- draft|pending|approved|rejected, so a delist UPDATE would be REJECTED with
-- 23514 without this widen. Postgres cannot modify a CHECK in place → DROP then
-- ADD. Additive: adding a value is non-breaking to existing rows.
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴🔴🔴 ORDERING-CRITICAL — unlike the two inert P3b table migrations, THIS one
-- is timing-sharp because existing code paths are unaffected but NEW writes fail
-- without it:
--   * Apply to the DEV CLONE **before** PR3's preview smoke test runs, or the
--     preview 500s on the constraint (the preview-DB-drift → smoke-500 trap:
--     MEMORY app_blocks_marketplace_images_and_preview_db_drift_2026_06_30).
--   * Apply to PROD nvme0 **before** PR3 (main → release) deploys, or the first
--     live delist UPDATE hits 23514 → 500.
-- The migration-agreement unit test
-- (src/server/services/blocks/__tests__/app-listing-status.constants.test.ts)
-- parses THIS file's IN-list and asserts it equals the code's APP_LISTING_STATUSES
-- const, catching code/DDL drift at CI time — but it does NOT apply the DDL. The
-- human apply above is still required.
--
-- Idempotent: DROP IF EXISTS then ADD, so a manual re-run is a no-op.
-- (To add 'suspended' later: the same two-line ALTER with the value appended.)

ALTER TABLE "app_listings" DROP CONSTRAINT IF EXISTS "app_listings_status_check";
ALTER TABLE "app_listings" ADD  CONSTRAINT "app_listings_status_check"
  CHECK ("status" IN ('draft', 'pending', 'approved', 'rejected', 'removed'));
