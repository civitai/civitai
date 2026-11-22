-- Offline-access cut records: widen the app_listing_moderation_events action CHECK
-- Adds TWO moderation actions, written by `connect-offline-takedown.ts` only:
--   * 'offline-cut'        — a moderator takedown (or a moderator retry) of a connect listing
--                            deleted the app's refresh tokens. `after` = {clientId, deleted}.
--   * 'offline-cut-failed' — the cut was attempted and failed. `after` = {clientId};
--                            `detail` = the error message.
-- Neither changes `app_listings.status`. Both are written only while the `oauth-offline-grant`
-- flag is on, and both are withheld from the owner's history.
-- Event shape: see `APP_LISTING_MODERATION_ACTIONS` in `offsite-moderation.schema.ts`.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is committed
-- for history and a human runs the SQL below on each environment (preview / dev, then
-- production). CI and deploys do not run it.
--
-- WITHOUT IT nothing breaks and nothing is lost but the history row: the row is written AFTER
-- the takedown commits, best-effort, so its 23514 is caught and logged, the takedown stands and
-- the cut result is still returned to the moderator. A "Retry cut" also still runs the cut; only
-- its history row is refused. Apply it before turning the flag on.
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20261224120200_app_listing_official), so no existing row can violate it. Postgres cannot
-- modify a CHECK in place, hence DROP then ADD, in one transaction so the table is never without
-- the constraint. Idempotent: re-running it is a no-op.
--
-- LOCKING: the DROP + ADD takes an ACCESS EXCLUSIVE lock on the table and the ADD validates
-- every row. `lock_timeout` bounds the wait for that lock to 5s, so a long-running reader makes
-- the apply fail (re-run it) instead of queueing every writer behind it.
--
-- ROLLBACK: re-run the CHECK half of the previous widen (the DROP + ADD of
-- "app_listing_mod_events_action_check" in 20261224120200_app_listing_official/migration.sql;
-- its ADD COLUMN is already idempotent). That fails while any 'offline-cut' or
-- 'offline-cut-failed' event exists, by design: those rows are the audit trail.
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
    'moderator-edit',
    'set-official',
    'offline-cut',
    'offline-cut-failed'
  ));
COMMIT;
