-- ============================================================
-- Moderator listing edits: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action, written by `app-listing-moderator-edit.ts`:
--   * 'moderator-edit' — a moderator edited a listing's details or store media without
--     holding a seat on it. Changes no `app_listings.status`.
-- Event shape: see `APP_LISTING_MODERATION_ACTIONS` in `offsite-moderation.schema.ts`.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is
-- committed for history and a human runs the SQL below on each environment (preview / dev,
-- then production). CI and deploys do not run it.
--
-- WITHOUT IT moderator edits to a listing they hold no seat on REFUSE, and that is the safe
-- direction: the audit row is inserted BEFORE the listing write, so its 23514 aborts the
-- edit and nothing changes unrecorded. Owner and collaborator edits never write this row
-- and work before, during and after the apply. Apply it before moderators need to edit.
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20261024120000_app_listing_mod_action_storage_doc), so no existing row can violate it.
-- Postgres cannot modify a CHECK in place, hence DROP then ADD, in one transaction so the
-- table is never without the constraint. Idempotent: re-running it is a no-op.
--
-- LOCKING: the DROP + ADD takes an ACCESS EXCLUSIVE lock on the table and the ADD validates
-- every row. `lock_timeout` bounds the wait for that lock to 5s, so a long-running reader
-- makes the apply fail (re-run it) instead of queueing every writer behind it.
--
-- ROLLBACK: re-apply the previous widen
-- (20261024120000_app_listing_mod_action_storage_doc/migration.sql). That fails while any
-- 'moderator-edit' event exists, by design: those rows are the audit trail.
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
    'moderator-edit'
  ));
COMMIT;
