-- ============================================================
-- App Store Listings (W13) — post-approval mgmt: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Phase 1 of W13 "post-approval listing management" adds three new moderation
-- actions that the procs write to `app_listing_moderation_events.action`:
--   * 'reset-to-pending'  — a mod bounces an APPROVED off-site listing back into
--     the review queue (approved -> pending + a fresh pending publish request).
--   * 'owner-unpublish'   — the OWNER hides their own approved listing
--     (approved -> removed), a self-service takedown (no re-review).
--   * 'owner-republish'   — the OWNER restores their own owner-unpublished listing
--     (removed -> approved), allowed ONLY when the most-recent event was an
--     owner-unpublish (never a mod delist/purge takedown-for-cause).
--
-- The P3b PR1 CHECK (20260706120100_w13_p3b_app_listing_moderation_events) only
-- allows delist|relist|claim|purge|report-resolve|report-dismiss, so a proc
-- writing one of the three new actions would be REJECTED with 23514 without this
-- widen. Postgres cannot modify a CHECK in place -> DROP then ADD. ADDITIVE: the
-- new IN-list is a strict SUPERSET of the old one, so no existing row can violate
-- it (nothing to backfill / re-validate).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴 ORDERING: like the sibling status widen (20260706120200_..._status_add_removed)
-- this is timing-sharp — existing code paths are unaffected, but the NEW procs'
-- first write fails without it:
--   * Apply to the DEV CLONE **before** the PR preview exercises the new procs, or
--     the preview 500s on the constraint (preview-DB-drift → smoke-500 trap).
--   * Apply to PROD nvme0 **before** this ships (main -> release), or the first
--     live reset-to-pending / owner-unpublish / owner-republish UPDATE hits 23514.
--
-- The migration-agreement unit test
-- (src/server/services/blocks/__tests__/app-listing-mod-action.constants.test.ts)
-- parses the LATEST action-CHECK migration `.sql` (this file) and asserts its
-- IN-list equals the code tuple APP_LISTING_MODERATION_ACTIONS, catching code/DDL
-- drift at CI time — but it does NOT apply the DDL. The human apply above is still
-- required.
--
-- Idempotent: DROP IF EXISTS then ADD, so a manual re-run is a no-op.
--
-- Wrapped in a single transaction so the DROP+ADD swap is ATOMIC: without it there
-- is a sub-ms window between DROP and ADD where the table has NO action CHECK and a
-- concurrent bad write could slip through. BEGIN/COMMIT closes that window (mirrors
-- the status_add_removed / P0 single-transaction precedent).
BEGIN;
ALTER TABLE "app_listing_moderation_events"
  DROP CONSTRAINT IF EXISTS "app_listing_mod_events_action_check";
ALTER TABLE "app_listing_moderation_events"
  ADD  CONSTRAINT "app_listing_mod_events_action_check"
  CHECK ("action" IN (
    'delist',
    'relist',
    'claim',
    'purge',
    'report-resolve',
    'report-dismiss',
    'reset-to-pending',
    'owner-unpublish',
    'owner-republish'
  ));
COMMIT;
