-- ============================================================
-- App Blocks — MARKETPLACE REVIEWS (5-star)
-- ============================================================
-- A parallel table to "ResourceReview" (which is hard-bound to model/version
-- FKs) so app blocks can carry star ratings without bending the model-review
-- shape. Backs:
--   - blocks.upsertReview / blocks.listReviews (gated dark behind the
--     mod-segmented appBlocks Flipt flag)
--   - getAppRatingTotals (AVG/COUNT, excludes `exclude` rows AND self-reviews)
--   - the marketplace `rating` sort (Bayesian shrinkage) + avg/count on cards
--   - the blue-buzz "leave a review" reward (fires ONCE per (user, app) on the
--     first create; per-(user,app) dedup anchored on the unique constraint)
--
-- ⚠️ MANUAL-APPLY. The main civitai DB (CNPG nvme0, role=postgres) does NOT run
-- `prisma migrate deploy` — this file is committed for HISTORY only and applied
-- BY HAND (psql) per environment. Apply to:
--   1. prod nvme0  (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev)
-- The table is ADDITIVE + read only by the dark, mod-gated marketplace +
-- review procedures, so applying it ahead of the code deploy is inert.
--
-- IF-NOT-EXISTS guards are used so a manual re-run is a no-op (Prisma's own
-- DDL is not idempotent; this is hand-applied, so we make it safe to re-run).

CREATE TABLE IF NOT EXISTS "app_block_reviews" (
  "id"            SERIAL PRIMARY KEY,
  -- The app block being reviewed. CASCADE so deleting an app reaps its reviews.
  "app_block_id"  TEXT NOT NULL REFERENCES "app_blocks"("id") ON DELETE CASCADE,
  -- The reviewer. CASCADE on GDPR user-delete.
  "user_id"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  -- 1..5 stars. Range is validated in the service (kept off the DB so a future
  -- product change doesn't require a manual ALTER on a hand-applied table), but
  -- a CHECK is cheap insurance against a bad direct write.
  "rating"        INTEGER NOT NULL,
  "recommended"   BOOLEAN NOT NULL DEFAULT true,
  "details"       TEXT,
  -- Moderator controls. exclude / tos_violation keep abusive reviews out of the
  -- rating aggregate + the Bayesian marketplace sort.
  "exclude"       BOOLEAN NOT NULL DEFAULT false,
  "tos_violation" BOOLEAN NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "app_block_reviews_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5)
);

-- One review per (user, app). Also the per-(user,app) idempotency anchor for the
-- blue-buzz reward (the create branch only fires when this insert succeeds).
CREATE UNIQUE INDEX IF NOT EXISTS "app_block_reviews_app_user_uniq"
  ON "app_block_reviews" ("app_block_id", "user_id");

-- Aggregate read path: AVG(rating) / COUNT(*) WHERE NOT exclude, per app.
CREATE INDEX IF NOT EXISTS "app_block_reviews_app_agg_idx"
  ON "app_block_reviews" ("app_block_id", "exclude");
