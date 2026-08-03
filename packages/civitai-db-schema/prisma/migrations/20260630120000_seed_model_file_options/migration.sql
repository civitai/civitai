-- ============================================================
-- Seed model file options (precisions + quant types) into KeyValue
-- ============================================================
-- Backs the mod-managed precision/quant-type lists read via dbKV under key
-- `modelFileOptions` (see src/server/services/model-file.service.ts). The app
-- falls back to the hardcoded constants when this row is absent, so this seed is
-- OPTIONAL — its only purpose is to materialize the row with the current values
-- so mods can edit it from day one via /api/admin/model-file-options.
--
-- ⚠️ MANUAL APPLY — the main civitai DB does NOT auto-apply migrations. This file
-- is committed for history; a HUMAN applies the SQL below per environment
-- (psql/retool). CI / deploy does NOT run it.
--
-- IDEMPOTENT + NON-DESTRUCTIVE:
--   - ON CONFLICT DO NOTHING: re-runnable, and never clobbers a row a mod has
--     already edited. To force-reset the lists to these defaults instead, change
--     the conflict clause to `DO UPDATE SET "value" = EXCLUDED."value"`.
--   - Values mirror constants.modelFileFp / constants.modelFileQuantTypes at the
--     time of writing.
INSERT INTO "KeyValue" ("key", "value")
VALUES (
  'modelFileOptions',
  '{"precisions":["fp16","fp8","nf4","fp32","bf16"],"quantTypes":["Q8_0","Q6_K","Q5_K_M","Q5_K_S","Q5_1","Q5_0","Q4_K_M","Q4_K_S","Q4_1","Q4_0","Q3_K_L","Q3_K_M","Q3_K_S","Q2_K","Q2_K_S","IQ4_XS","IQ4_NL","IQ3_XS","IQ3_XXS","IQ2_XS","IQ2_XXS","IQ2_S","IQ2_M","IQ1_S","IQ1_M"]}'::jsonb
)
ON CONFLICT ("key") DO NOTHING;
