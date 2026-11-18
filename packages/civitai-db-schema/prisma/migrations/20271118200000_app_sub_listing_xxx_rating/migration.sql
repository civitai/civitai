-- ============================================================
-- App Store SUB-LISTINGS — an `xxx` card rating (content levels, build 3)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database). A
-- human runs this file against the main civitai database (the one holding `app_sub_listings`),
-- dev first, then production, BEFORE the code that writes `xxx` deploys.
--
-- WHY: an item card's rating is its item's content level. The ladder stopped at `x`, so an item
-- rated XXX showed as `x`, and the store's per-viewer filter could not tell it from X. The code
-- now writes `xxx` for an XXX item (and lets an author pick it), and filters it on its own.
--
-- WIDENING ONLY: both rating CHECKs on `app_sub_listings` admit one more value, `xxx`. No column,
-- index or row changes, and every existing row still passes. Safe before the code deploys:
-- nothing writes `xxx` until it does. If the code deploys first, a write of `xxx` fails its CHECK
-- (the publish or rating sync errors) until this is applied.
--
-- LOCKS: the DROP/ADD takes an ACCESS EXCLUSIVE lock on `app_sub_listings` (a small table) until
-- COMMIT, and the ADD validates every row under it. `lock_timeout` caps the wait at 3s; on
-- `canceling statement due to lock timeout` nothing was applied (one transaction): re-run.
--
-- IDEMPOTENT: each constraint is dropped if present and re-added under the same name.
--
-- ROLLBACK (only once no row carries `xxx`: `SELECT count(*) FROM app_sub_listings WHERE
-- content_rating = 'xxx' OR pending_content_rating = 'xxx'` must be 0, or the ADD fails):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "app_sub_listings"
--     DROP CONSTRAINT IF EXISTS "app_sub_listings_content_rating_check",
--     ADD CONSTRAINT "app_sub_listings_content_rating_check"
--       CHECK ("content_rating" IS NULL OR "content_rating" IN ('g','pg','pg13','r','x')),
--     DROP CONSTRAINT IF EXISTS "app_sub_listings_pending_content_rating_check",
--     ADD CONSTRAINT "app_sub_listings_pending_content_rating_check"
--       CHECK ("pending_content_rating" IS NULL OR "pending_content_rating" IN ('g','pg','pg13','r','x'));
--   COMMIT;
--
-- The IN-lists are kept in lockstep with `APP_SUB_LISTING_CONTENT_RATINGS` by
-- `src/server/services/blocks/__tests__/app-sub-listing.constants.test.ts`, which parses this file.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE "app_sub_listings"
  DROP CONSTRAINT IF EXISTS "app_sub_listings_content_rating_check",
  ADD CONSTRAINT "app_sub_listings_content_rating_check"
    CHECK ("content_rating" IS NULL OR "content_rating" IN ('g','pg','pg13','r','x','xxx')),
  DROP CONSTRAINT IF EXISTS "app_sub_listings_pending_content_rating_check",
  ADD CONSTRAINT "app_sub_listings_pending_content_rating_check"
    CHECK ("pending_content_rating" IS NULL OR "pending_content_rating" IN ('g','pg','pg13','r','x','xxx'));

COMMIT;
