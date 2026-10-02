-- ============================================================
-- App listing visibility levels (W14): widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action:
--   * 'set-visibility' — a moderator changed a listing's per-listing VISIBILITY LEVEL
--     (`app_listings.visibility`: private|moderators|testers|public). Like
--     'message-owner' and 'purge-user-storage' it changes NO listing STATUS, which is
--     why it belongs in `STATE_NEUTRAL_MODERATION_ACTIONS` and must never be added to
--     `LISTING_STATUS_CHANGING_MODERATION_ACTIONS` — doing so would let it displace the
--     `owner-unpublish` event underneath it and hand the owner back edit rights on
--     content a moderator removed.
--
--     `reason`  — the moderator's rationale (optional on this action; a level change is
--                 reversible and changes no status, unlike delist/relist/purge).
--     `before`  — { visibility: <previous level> }
--     `after`   — { visibility: <new level> }
--     `detail`  — a rendered one-line summary.
--
--     The OWNER setting their own listing's level writes NO event. This taxonomy is for
--     moderator actions against a listing; an owner editing their own listing is an
--     ordinary authored edit, and the other owner-originated verbs here
--     ('owner-unpublish'/'owner-republish') are in it only because they change STATUS.
--
-- The current CHECK (20260912120000_app_listing_mod_action_purge_user_storage) allows
-- delist|relist|claim|purge|report-resolve|report-dismiss|reset-to-pending|
-- owner-unpublish|owner-republish|message-owner|purge-user-storage, so the moderator
-- path's audit write would be REJECTED with 23514 without this widen. Postgres cannot
-- modify a CHECK in place -> DROP then ADD. ADDITIVE: the new IN-list is a strict
-- SUPERSET of the old one, so no existing row can violate it (nothing to backfill or
-- re-validate).
--
-- NOT AUTO-APPLIED. Per CLAUDE.md -> Database the main civitai DB does NOT auto-apply
-- migrations (no `prisma migrate deploy`). This file is committed for HISTORY ONLY; a
-- HUMAN applies the SQL below per environment. Apply to BOTH the production primary and
-- the dev clone.
--
-- ORDERING: timing-sharp, exactly like the widen it follows. Existing code paths are
-- unaffected, but the moderator proc's FIRST write fails without it:
--   * Apply to the DEV CLONE before a PR preview exercises
--     `appListings.setListingVisibility` as a moderator, or the preview 500s on the
--     constraint.
--   * Apply to PROD before this ships, or the first live moderator level change hits
--     23514. The failure mode is the GOOD one: the audit row is written inside the same
--     transaction as the level change, so a missing widen means the level is NOT changed
--     rather than changed unrecorded.
--   * The OWNER path writes no event and is unaffected by this migration.
--   * This migration is INDEPENDENT of its sibling
--     `20261001170000_app_listing_visibility` (the column itself). Apply both; neither
--     needs the other to have run first, and the owner path needs only the column.
--
-- The migration-agreement unit test
-- (src/server/services/blocks/__tests__/app-listing-mod-action.constants.test.ts)
-- parses the LATEST action-CHECK migration `.sql` (this file, by sorted dir name) and
-- asserts its IN-list equals the code tuple APP_LISTING_MODERATION_ACTIONS, catching
-- code/DDL drift at CI time — but it does NOT apply the DDL.
--
-- Idempotent: DROP IF EXISTS then ADD, so a manual re-run is a no-op.
--
-- Wrapped in a single transaction so the DROP+ADD swap is ATOMIC: without it there is a
-- sub-ms window between DROP and ADD where the table has NO action CHECK and a
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
    'message-owner',
    'purge-user-storage',
    'set-visibility'
  ));
COMMIT;
