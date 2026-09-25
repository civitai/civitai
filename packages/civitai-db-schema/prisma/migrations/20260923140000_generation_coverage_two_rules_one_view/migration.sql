-- GenerationCoverage — one view, both rules, one row per version.
--
-- The two coverage rules used to live in two views, so choosing a rule meant choosing a TABLE NAME,
-- which pushed a runtime decision into every query, every Prisma relation and every selector. This
-- replaces the live view with one carrying two booleans: `covered` (the live rule, a checkpoint must
-- be in the weekly auction's `CoveredCheckpoint` list) and `coveredNext` (the staged rule, which
-- covers community checkpoints so paid model loading can download them on demand).
--
-- `GenerationCoverageNext` is left in place and drops separately, AFTER the deploy — see the foot of
-- this file.
--
-- 🔴 ROW EXISTENCE NO LONGER MEANS COVERED. Both old views emitted rows only for covered versions,
-- so `EXISTS (SELECT 1 FROM "GenerationCoverage" …)` was a coverage test. Here a row exists when
-- EITHER rule covers, so every reader must test a column. Readers outside this repo that select
-- `gc.covered` keep working unchanged.
--
-- 🔴 BOTH RULES NOW EXCLUDE MODERATED MODELS. `m.mode IS NULL` had guarded the staged rule since
-- 2026-09-11 and never guarded the live one, so a flag selecting between them could un-block
-- generation for Archived and TakenDown models. Supersedes
-- `20260923120000_generation_coverage_exclude_moderated_models`, which applied that guard alone.
--
-- 🔴 APPLYING THIS NARROWS `covered` THE MOMENT IT RUNS, and coverage is cached. Follow it with the
-- steps `20260817200000_generation_coverage_require_rentcivit` prescribes:
--   1. Capture the affected ids BEFORE applying —
--      SELECT gc."modelId", gc."modelVersionId" FROM "GenerationCoverage" gc
--        JOIN "Model" m ON m.id = gc."modelId" WHERE m.mode IS NOT NULL;
--   2. PURGE BY KEY (not wholesale) the two caches that store coverage for those models:
--      packed:generation:resource-data-*   (resourceDataCache, TTL 1h)
--      packed:caches:data-for-model*       (dataForModelsCache, TTL 1d)
--   3. Re-queue those models into the models search index.
--
-- SHAPE. The rules differ in exactly two things — the file-format exclusions and how a checkpoint
-- qualifies — so the shared work is computed ONCE per version in two lateral subqueries. Written as
-- two independent boolean expressions instead, each version pays three `ModelFile` lookups rather
-- than one pass, which measured slower and read more buffers.
--
-- CTEs were tried and rejected: Postgres inlines a non-materialized CTE, so the shared expression is
-- still evaluated twice, and `MATERIALIZED` would spool intermediate rows for a ~1M-row view and
-- block predicate pushdown.
--
-- ⚠️ `bool_or` reads every file of a version where `EXISTS` stops at the first match. That is the
-- right trade at a handful of files per version; it would invert for a version carrying thousands.
--
-- Measured coverage impact and the query behind it:
-- docs/features/paid-model-loading-coverage.md.

CREATE OR REPLACE VIEW "GenerationCoverage" AS
SELECT "modelId", "modelVersionId", covered, "coveredNext"
FROM (
  SELECT
    m.id AS "modelId",
    mv.id AS "modelVersionId",
    -- The rules differ only in which file test and which checkpoint qualification they use.
    (b.eco OR b.ext OR (b.common AND f.live_file AND (b.other_type OR (b.ckpt AND b.auction)))) AS covered,
    (b.eco OR b.ext OR (b.common AND f.next_file AND (b.other_type OR (b.ckpt AND f.safetensor)))) AS "coveredNext"
  FROM "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"

  LEFT JOIN LATERAL (
    SELECT
      -- The generator's per-ecosystem default models.
      (mv.id IN (SELECT "EcosystemCheckpoints".id FROM "EcosystemCheckpoints")) AS eco,
      -- File-less external/API generation. Covered, never loadable.
      (
        mv."usageControl" = 'ExternalGeneration'::"ModelUsageControl"
        AND mv.status = 'Published'::"ModelStatus"
        AND NOT m.poi
      ) AS ext,
      -- The ordinary path, minus the file and type tests the two rules disagree about.
      (
        NOT m.poi
        AND (
          mv.status = 'Published'::"ModelStatus"
          OR m.availability = 'Private'::"Availability"
          OR m."uploadType" = 'Trained'::"ModelUploadType"
        )
        AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse"]
        AND (
          mv."baseModel" IN (SELECT "GenerationBaseModel"."baseModel" FROM "GenerationBaseModel")
          OR m.type = 'Upscaler'::"ModelType"
        )
      ) AS common,
      (m.type = 'Checkpoint'::"ModelType" AND mv."baseModelType" = 'Standard') AS ckpt,
      (
        m.type = ANY (ARRAY['LORA'::"ModelType", 'TextualInversion'::"ModelType", 'VAE'::"ModelType", 'LoCon'::"ModelType", 'DoRA'::"ModelType"])
        OR m.type = 'Upscaler'::"ModelType"
      ) AS other_type,
      -- LIVE only: the weekly auction's residency list.
      (mv.id IN (SELECT "CoveredCheckpoint".version_id FROM "CoveredCheckpoint")) AS auction
  ) b ON TRUE

  -- One pass over this version's files answers all three file questions.
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(bool_or(ok_live), false) AS live_file,
      COALESCE(bool_or(ok_next), false) AS next_file,
      COALESCE(bool_or(is_safetensor), false) AS safetensor
    FROM (
      SELECT
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            -- LIVE excludes Diffusers for every type.
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Diffusers'::text, 'Core ML'::text, 'ONNX'::text])
          )
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
        ) AS ok_live,
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            -- STAGED accepts Diffusers for everything except checkpoints, which the SafeTensor
            -- test below handles separately.
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Core ML'::text, 'ONNX'::text])
          )
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
        ) AS ok_next,
        -- STAGED only: the loader serves SafeTensor, so a checkpoint without one cannot be loaded.
        (
          mf."scannedAt" IS NOT NULL
          AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
          AND mf.metadata ->> 'format'::text = 'SafeTensor'
        ) AS is_safetensor
      FROM "ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
    ) files
  ) f ON TRUE

  -- Both rules carry this, so it is stated once: a moderated model is not covered under either.
  WHERE m.mode IS NULL
) rules
WHERE covered OR "coveredNext";

-- `GenerationCoverageNext` is deliberately LEFT IN PLACE. Pods running the previous build still
-- read it, so dropping it here would break them between this migration and the deploy. Drop it
-- afterwards, once nothing references it — the code in this change does not.
