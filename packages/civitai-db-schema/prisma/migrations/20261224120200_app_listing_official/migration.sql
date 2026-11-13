-- App Store listings: a moderator-set "Official" flag ("made by the Civitai team"), shown as a
-- badge on the store card and the app page. Mirrors `Model.isOfficial` / `Article.isOfficial`:
-- a provenance claim with a moderator-only setter, never an author-editable field.
--
-- Two changes, in ONE transaction so the environment never has the column without the audit
-- action that records its writes (or the reverse):
--   1. `app_listings.is_official BOOLEAN NOT NULL DEFAULT false`.
--   2. Widens the `app_listing_moderation_events` action CHECK with ONE action,
--      'set-official', written by `app-listing-official.service.ts` in the same transaction
--      as the flag write. Changes no `app_listings.status`.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is committed
-- for history and a human runs the SQL below on each environment (preview / dev, then
-- production). CI and deploys do not run it.
--
-- DEPLOY ORDER: either order is safe. The column is marked no-type in `schema.full.prisma`, so
-- the generated Prisma client does not know it and no Prisma query can name it. It is read and
-- written by raw SQL in `app-listing-official.service.ts` only: before this file is applied
-- every read there degrades to "not official" (no badge) and the moderator toggle refuses with
-- PRECONDITION_FAILED, writing nothing.
--
-- LOCKING / SIZE: `ADD COLUMN ... NOT NULL DEFAULT <constant>` is metadata-only on Postgres
-- 11+ (the default is stored in the catalog; no table rewrite, no per-row write), so its
-- ACCESS EXCLUSIVE lock on "app_listings" is held only for the catalog update. The CHECK
-- DROP + ADD takes ACCESS EXCLUSIVE on "app_listing_moderation_events" and validates every
-- row. `lock_timeout` bounds the wait for either lock to 5s, so a long-running reader makes
-- the apply fail (re-run it) instead of queueing every writer behind it.
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20261103120000_app_listing_mod_action_moderator_edit), so no existing row can violate it.
-- Idempotent: re-running it is a no-op (`IF NOT EXISTS` / `IF EXISTS`).
--
-- ROLLBACK: re-apply the previous widen
-- (20261103120000_app_listing_mod_action_moderator_edit/migration.sql), which fails while any
-- 'set-official' event exists, by design (those rows are the audit trail), then
-- `ALTER TABLE "app_listings" DROP COLUMN IF EXISTS "is_official";` once no deployed code
-- reads it.
--
-- Verify by reading back the column (`information_schema.columns`) and the constraint
-- (`pg_get_constraintdef`). `app-listing-mod-action.constants.test.ts` asserts the IN-list
-- below equals the code tuple; it does not apply the DDL.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "app_listings" ADD COLUMN IF NOT EXISTS "is_official" BOOLEAN NOT NULL DEFAULT false;

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
    'set-official'
  ));
COMMIT;
