-- Adds the two base models whose licences forbid mature content but which were
-- never added to this table: `Ideogram 4.0` (ideogram nc, disableMature) and
-- `SVD XT` (the SVD research licence). `nsfwRestrictedBaseModels` in
-- src/server/common/constants.ts has carried both all along, so Meilisearch has
-- been hiding their R/X/XXX images while every Postgres read path showed them.
-- Approved by Justin 2026-08-24 (ClickUp 868kv4yn2).
--
-- 🔴 APPLY AFTER the RestrictedImagesByBaseModel teardown (ClickUp 868kv0qz3).
-- While `refresh_restricted_images_restricted_models` still exists, each row
-- inserted here fires a `REFRESH MATERIALIZED VIEW CONCURRENTLY` inline in this
-- transaction over a 439M-row seq scan, measured near the cluster's 120s
-- statement_timeout. Applied before the teardown, this two-row insert either
-- stalls for ~100s or aborts.
--
-- No backfill accompanies this. The hourly `reconcile-restricted-images` job
-- flags the ~6,326 affected images on its next run.

INSERT INTO "RestrictedBaseModels" ("baseModel")
VALUES ('Ideogram 4.0'), ('SVD XT')
ON CONFLICT DO NOTHING;
