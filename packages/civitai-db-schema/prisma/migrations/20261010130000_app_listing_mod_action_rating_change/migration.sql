-- ============================================================
-- Listing content-rating history: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action:
--   * 'rating-change' — a listing's `content_rating` moved without anyone setting it by
--     hand: a go-live or moderator asset edit floored it at its media, a review replaced it,
--     or a moderator re-rated one of its images. Changes no `app_listings.status`.
--
--     `reason` — the owner-facing sentence (the owner history shows only this).
--     `detail` — the cause: 'store-media' | 'image-review' | 'review'.
--     `before` — { contentRating }.   `after` — { contentRating, imageIds }.
--
-- MANUAL APPLY. Migrations are not auto-applied to the main database: this file is
-- committed for history and a human runs the SQL below on each environment (preview / dev,
-- then production). CI and deploys do not run it.
--
-- WITHOUT IT, what happens depends on the writer (see `app-listing-rating.ts`):
--   * go-live / asset-edit sites record the event AFTER their transaction commits and
--     swallow a failure, so approvals and rating raises behave exactly as before — the
--     history row is simply missing, with a warning logged.
--   * the moderator image re-rate hook writes the rating and the event in ONE transaction,
--     so the insert's 23514 rolls the rating write back: the image re-rate succeeds and the
--     listing rating does not move (in either direction) until this is applied.
-- So apply it BEFORE the code ships, or the re-derive is inert.
--
-- ADDITIVE: the new IN-list is a strict superset of the previous widen
-- (20261004120000_app_listing_mod_action_set_visibility), so no existing row can violate it.
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
    'rating-change'
  ));
COMMIT;
