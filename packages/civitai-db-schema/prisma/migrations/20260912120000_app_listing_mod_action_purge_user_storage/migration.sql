-- ============================================================
-- App Blocks per-user storage takedown: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action:
--   * 'purge-user-storage' — a moderator removed one user's PER-USER App Storage
--     (`kv`) rows, either in a single app or, as one row per app, across every app
--     that held rows for that account. Like 'message-owner' it changes NO listing
--     state: the row exists to make a destructive act against a USER's stored data
--     attributable and reviewable.
--
--     `reason`  — the moderator's required rationale (3..1000 chars).
--     `detail`  — a rendered one-line summary naming the target user and the counts.
--     `before`  — the PRE-PURGE snapshot: { targetUserId, appBlockId, schema, scope,
--                 purgeBatchId, rowCount, totalBytes, counter, counterMatchesRows,
--                 sharedRowsNotPurged, rowsTruncated, snapshotRowCap, rows[] }, where
--                 each `rows[]` entry is { key, blockInstanceId, sizeBytes, updatedAt,
--                 valueMd5 }. 🔴 Deliberately NO stored VALUES — a key + size +
--                 content fingerprint says what was destroyed without copying the
--                 purged content into a second database, which would defeat the purge.
--     `after`   — { deletedRowCount, deletedBytes, userQuotaReset, completedAt },
--                 stamped after the delete commits.
--
--     `app_listing_id` MAY BE NULL for this action — an AppBlock without an
--     AppListing row still has storage to purge. The column is already nullable
--     (`onDelete: SetNull`, "so the audit event outlives a listing purge"), and
--     `slug` is still written, so the event stays self-describing. Such a row is
--     absent from the per-listing history view and present in the per-actor one.
--
-- The current CHECK (20260824120000_app_listing_mod_action_message_owner) allows
-- delist|relist|claim|purge|report-resolve|report-dismiss|reset-to-pending|
-- owner-unpublish|owner-republish|message-owner, so the purge path's audit write
-- would be REJECTED with 23514 without this widen. Postgres cannot modify a CHECK
-- in place -> DROP then ADD. ADDITIVE: the new IN-list is a strict SUPERSET of the
-- old one, so no existing row can violate it (nothing to backfill / re-validate).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai
-- CNPG nvme0 DB does NOT auto-apply migrations (no prisma migrate deploy). This
-- file is committed for HISTORY ONLY; a HUMAN applies the SQL below per
-- environment (psql/retool). CI / deploy do NOT run it. Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴 ORDERING: timing-sharp, exactly like the widen it follows. Existing code paths
-- are unaffected, but the NEW procs' first write fails without it:
--   * Apply to the DEV CLONE **before** a PR preview exercises
--     `apps.mod.userStorage.purgeApp` / `purgeAccount`, or the preview 500s on the
--     constraint (preview-DB-drift -> smoke-500 trap).
--   * Apply to PROD nvme0 **before** this ships (main -> release), or the first live
--     purge hits 23514 — and the failure mode is the GOOD one: the audit row is
--     written BEFORE anything is deleted, so a missing CHECK widen means the rows
--     are never purged, not that they are purged unrecorded.
--   * The READ surface (`apps.mod.userStorage.preview`) writes nothing and is
--     unaffected by this migration — it works before, during and after the apply.
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
    'message-owner',
    'purge-user-storage'
  ));
COMMIT;
