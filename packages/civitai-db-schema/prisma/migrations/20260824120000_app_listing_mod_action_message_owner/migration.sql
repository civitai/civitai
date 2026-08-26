-- ============================================================
-- Moderator → app-developer messaging: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action:
--   * 'message-owner' — a moderator sent the app's canonical owner (and, on
--     request, its accepted collaborators) a free-text message. Unlike every other
--     action in this taxonomy it changes NO listing state: the row exists to make
--     the message attributable and reviewable. `reason` carries the SUBJECT and
--     `detail` the BODY, so the moderation history renders what was actually said;
--     `after` records the delivery decision (`recipientUserIds`,
--     `includeCollaborators`), which is the part that cannot be reconstructed later
--     because the canonical owner can change after the fact.
--
-- The current CHECK (20260713120000_w13_post_approval_mod_actions) allows
-- delist|relist|claim|purge|report-resolve|report-dismiss|reset-to-pending|
-- owner-unpublish|owner-republish, so `messageAppOwner` would be REJECTED with 23514
-- without this widen. Postgres cannot modify a CHECK in place -> DROP then ADD.
-- ADDITIVE: the new IN-list is a strict SUPERSET of the old one, so no existing row
-- can violate it (nothing to backfill / re-validate).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴 ORDERING: timing-sharp, exactly like the widen it follows. Existing code paths
-- are unaffected, but the NEW proc's first write fails without it:
--   * Apply to the DEV CLONE **before** a PR preview exercises `messageAppOwner`, or
--     the preview 500s on the constraint (preview-DB-drift → smoke-500 trap).
--   * Apply to PROD nvme0 **before** this ships (main -> release), or the first live
--     moderator message hits 23514 — and note the failure mode is the GOOD one: the
--     audit row is written BEFORE delivery, so a missing CHECK widen means the
--     message is never sent, not that it is sent unrecorded.
--
-- The migration-agreement unit test
-- (src/server/services/blocks/__tests__/app-listing-mod-action.constants.test.ts)
-- parses the LATEST action-CHECK migration `.sql` (this file, by sorted dir name)
-- and asserts its IN-list equals the code tuple APP_LISTING_MODERATION_ACTIONS,
-- catching code/DDL drift at CI time — but it does NOT apply the DDL. The human
-- apply above is still required.
--
-- Idempotent: DROP IF EXISTS then ADD, so a manual re-run is a no-op.
--
-- Wrapped in a single transaction so the DROP+ADD swap is ATOMIC: without it there
-- is a sub-ms window between DROP and ADD where the table has NO action CHECK and a
-- concurrent bad write could slip through.
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
    'owner-republish',
    'message-owner'
  ));
COMMIT;
