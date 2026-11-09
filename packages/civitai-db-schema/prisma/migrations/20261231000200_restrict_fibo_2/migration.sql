-- Adds `Fibo 2.0` (Bria, disableMature), which `nsfwRestrictedBaseModels` in
-- src/server/common/constants.ts carries from this release. Idempotent: a row
-- added by hand earlier is left as is.
--
-- Before applying, confirm the `refresh_restricted_images_restricted_models`
-- trigger is gone (see 20260824120000_restrict_ideogram_and_svd_xt): while it
-- exists, this insert refreshes a materialized view inline and can hit the
-- statement timeout.
--
-- No backfill: no model can be published on this base model before the release
-- that adds it, and the hourly `reconcile-restricted-images` job flags any
-- affected images on its next run.

INSERT INTO "RestrictedBaseModels" ("baseModel")
VALUES ('Fibo 2.0')
ON CONFLICT DO NOTHING;
