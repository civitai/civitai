-- Model3D reviews moved from 1-5 stars to thumbs up/down. The legacy
-- `rating` column on Model3DReview and the derived `ratingAvg` on
-- Model3DMetric are no longer written or read by any consumer — the UI
-- and the metrics rollup both derive everything from `recommendedCount`
-- and `ratingCount`. This migration drops both columns end-to-end.
--
-- Safe to run because:
--   * No production deploy has shipped the original star UI.
--   * All upserts/selects/aggregations in the codebase have been
--     migrated to read `recommended` directly.
--
-- Apply manually per the project's policy (we do NOT use `prisma migrate
-- deploy` — see CLAUDE.md "Database").

ALTER TABLE "Model3DReview"
  DROP COLUMN IF EXISTS "rating";

ALTER TABLE "Model3DMetric"
  DROP COLUMN IF EXISTS "ratingAvg";
