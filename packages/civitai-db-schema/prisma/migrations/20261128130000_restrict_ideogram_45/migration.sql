-- Adds `Ideogram 4.5` ('ideogram tos', disableMature), which
-- `nsfwRestrictedBaseModels` in src/server/common/constants.ts already carries.
-- Idempotent: a row added by hand earlier is left as is.
--
-- Before applying, confirm the `refresh_restricted_images_restricted_models`
-- trigger is gone (see 20260824120000_restrict_ideogram_and_svd_xt): while it
-- exists, this insert refreshes a materialized view inline and can hit the
-- statement timeout.
--
-- No backfill: the hourly `reconcile-restricted-images` job flags affected
-- images on its next run.

INSERT INTO "RestrictedBaseModels" ("baseModel")
VALUES ('Ideogram 4.5')
ON CONFLICT DO NOTHING;
