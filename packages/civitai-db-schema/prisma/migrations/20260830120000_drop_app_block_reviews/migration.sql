-- ============================================================
-- App Blocks — DROP the legacy 5-star MARKETPLACE REVIEWS table
-- ============================================================
-- Reverses 20260621120000_app_block_reviews. The 5-star `AppBlockReview`
-- system is superseded by the thumbs-based `AppListingReview`
-- (`app_listing_reviews` + the `app_listing_metrics` rollup), which is what
-- the live store reads and sorts on.
--
-- WHY IT IS SAFE TO DROP RATHER THAN MIGRATE:
--   - The 5-star WRITE form (`<AppBlockReviews>`) had exactly two hosts, and
--     both were unreachable: the `/apps/[appBlockId]` detail route now
--     redirects to the store detail, and `AppDetailsModal` is opened only from
--     `AppBlockCard`, which renders only inside `MarketplaceBody` — a component
--     with no importer in app code since `/apps` swapped to the unified store.
--   - The table is empty in production (the surface never had a lit entry
--     point), so there are no rows to migrate into `app_listing_reviews`.
--
-- ⚠️ MANUAL-APPLY, AND NOT YET APPLIED ANYWHERE. The main civitai DB does NOT
-- run `prisma migrate deploy` — this file is committed for HISTORY only and is
-- applied BY HAND (psql) per environment by a human. Nothing in CI or the
-- deploy pipeline will run it. Apply to:
--   1. prod   (the live civitai DB)
--   2. the dev clone
--
-- ORDERING: apply this AFTER the code change ships. The application no longer
-- references `app_block_reviews` in any query, so the drop is inert once the
-- new image is serving; running it BEFORE the deploy would 500 the legacy
-- marketplace read path (`blocks.listAvailable` / `blocks.getAppDetail`), which
-- is dark but still callable.
--
-- 🔴 CONFIRM BEFORE RUNNING. This is destructive and there is no undo:
--     SELECT COUNT(*) FROM "app_block_reviews";
--   Expect 0. If it is NOT 0, STOP and migrate the rows into
--   "app_listing_reviews" first — do not drop data on the strength of this
--   comment.
--
-- IF-EXISTS guards so a manual re-run is a no-op.

-- The two indexes go with the table, but drop them explicitly so a partially
-- applied state (table already gone, indexes somehow left) still converges.
DROP INDEX IF EXISTS "app_block_reviews_app_agg_idx";
DROP INDEX IF EXISTS "app_block_reviews_app_user_uniq";

DROP TABLE IF EXISTS "app_block_reviews";
