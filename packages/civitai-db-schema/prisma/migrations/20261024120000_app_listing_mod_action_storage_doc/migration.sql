-- ============================================================
-- App Blocks document-store takedown: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds THREE moderation actions, written by `doc-store-moderation.service.ts`
-- (`apps.mod.docStore.setHidden` / `.delete`):
--   * 'storage-doc-hide'   — a moderator hid one shared document in an app's document store.
--   * 'storage-doc-unhide' — a moderator reversed such a hide.
--   * 'storage-doc-delete' — a moderator hard-deleted one shared document.
-- None changes `app_listings.status`. Event shape: see `APP_LISTING_MODERATION_ACTIONS` in
-- `offsite-moderation.schema.ts`.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is
-- committed for history and a human runs the SQL below on each environment (preview / dev,
-- then production). CI and deploys do not run it.
--
-- WITHOUT IT the three moderator actions REFUSE, and that is the safe direction: the audit
-- row is inserted BEFORE the document is touched, so its 23514 aborts the action and
-- nothing is hidden or deleted unrecorded. The queue and the document read write nothing
-- here and work before, during and after the apply. Apply it before moderators need the
-- takedown.
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20261010130000_app_listing_mod_action_rating_change), so no existing row can violate it.
-- Postgres cannot modify a CHECK in place, hence DROP then ADD, in one transaction so the
-- table is never without the constraint. Idempotent: re-running it is a no-op.
--
-- Verify by reading the constraint back (`pg_get_constraintdef`), not by exercising the app.
-- `app-listing-mod-action.constants.test.ts` asserts this IN-list equals the code tuple; it
-- does not apply the DDL.
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
    'set-visibility',
    'rating-change',
    'storage-doc-hide',
    'storage-doc-unhide',
    'storage-doc-delete'
  ));
COMMIT;
