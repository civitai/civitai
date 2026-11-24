-- App Storage data-migration records: widen the app_listing_moderation_events action CHECK
-- Adds TWO moderation actions, written by `storage-mark-migration.service.ts` only
-- (`apps.mod.docStore.maintenance.*`):
--   * 'storage-mark-migration'   — a moderator migrated one mark of one collection into a
--                                  viewer-keyed collection (key check, freeze, copy, verify).
--   * 'storage-collection-purge' — a moderator purged every document of one collection (the
--                                  per-collection purge, or a mark migration's rollback).
-- Neither changes `app_listings.status`. Both are withheld from the owner's history.
-- Event shape: see `APP_LISTING_MODERATION_ACTIONS` in `offsite-moderation.schema.ts`.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is committed
-- for history and a human runs the SQL below on each environment (preview / dev, then
-- production). CI and deploys do not run it.
--
-- WITHOUT IT the ops do not run: each writes its audit row BEFORE it changes anything, so the
-- CHECK's 23514 refuses the op with nothing written. Apply it before running a migration or a
-- purge. (The ops also need the datastore migration `20261123120000_appdata_maint_run.sql`.)
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20271120230000_app_listing_mod_action_offline_cut), so no existing row can violate it.
-- Postgres cannot modify a CHECK in place, hence DROP then ADD, in one transaction so the table
-- is never without the constraint. Idempotent: re-running it is a no-op.
--
-- LOCKING: the DROP + ADD takes an ACCESS EXCLUSIVE lock on the table and the ADD validates
-- every row. `lock_timeout` bounds the wait for that lock to 5s, so a long-running reader makes
-- the apply fail (re-run it) instead of queueing every writer behind it.
--
-- ROLLBACK: re-run the previous widen (20271120230000_app_listing_mod_action_offline_cut). That
-- fails while any 'storage-mark-migration' or 'storage-collection-purge' event exists, by design:
-- those rows are the audit trail.
--
-- Verify by reading the constraint back (`pg_get_constraintdef`), not by exercising the app.
-- `app-listing-mod-action.constants.test.ts` asserts this IN-list equals the code tuple; it
-- does not apply the DDL.
BEGIN;
SET LOCAL lock_timeout = '5s';
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
    'set-visibility',
    'rating-change',
    'storage-doc-hide',
    'storage-doc-unhide',
    'storage-doc-delete',
    'storage-doc-dismiss',
    'storage-mark-migration',
    'storage-collection-purge',
    'moderator-edit',
    'set-official',
    'offline-cut',
    'offline-cut-failed'
  ));
COMMIT;
