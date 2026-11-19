-- GenerationCoverage: a trained file covers its version only once it has an epoch.
--
-- Both rules accepted any file carrying `metadata.trainingResults`. A run that fails or is still
-- running leaves its Training Data zip with `trainingResults.epochs = []`, so the version came out
-- covered: its page offered Create and the generator sent an AIR that can only resolve to the
-- dataset zip. On 2026-11-05, 1,414 covered versions had no other file. The test now requires
-- `epochs` to be an array holding at least one epoch object (both v1 and v2 store objects).
-- `@> '[{}]'` rather than `-> 0`: jsonb `-> 0` on a scalar returns the scalar, so a v1 file with
-- `epochs: null` would still pass.
--
-- Everything else is unchanged from `20261224130000_generation_coverage_exclude_failed_scan`,
-- including its failed-scan exclusion. It replaces
-- `20261105120000_generation_coverage_training_results_need_epoch`, removed unapplied: that file
-- was built on an older view and sorted before 20261224130000, so applying it would have dropped
-- the exclusion.
--
-- APPLYING THIS NARROWS `covered` AND `coveredNext` THE MOMENT IT RUNS, and coverage is cached.
-- Per writable env:
--   1. Snapshot the view BEFORE applying, and diff it after: the rows that lost `covered` or
--      `coveredNext` are the affected ids —
--      CREATE TEMP TABLE gc_before AS SELECT * FROM "GenerationCoverage";
--      -- dry run this file inside BEGIN; ... ROLLBACK; then apply, then (all in the SAME session:
--      -- a temp table does not outlive it):
--      SELECT b."modelId", b."modelVersionId" FROM gc_before b
--        LEFT JOIN "GenerationCoverage" a USING ("modelVersionId")
--      WHERE (b.covered AND a.covered IS NOT TRUE) OR (b."coveredNext" AND a."coveredNext" IS NOT TRUE);
--   2. PURGE BY KEY (not wholesale) the two caches that store coverage for those models:
--      packed:generation:resource-data-*   (resourceDataCache, TTL 1h)
--      packed:caches:data-for-model*       (dataForModelsCache, TTL 1d)
--   3. Bust the orchestrator's cached copy of those versions (bustOrchestratorModelCache), or it
--      keeps resolving them until its own cache expires.
--   4. Re-queue those models into the models search index.
--
-- Cost: one jsonb containment test per file row, on the `metadata` value the old test already read.

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
      COALESCE(bool_or(is_safetensor), false) AS safetensor,
      COALESCE(bool_or(scan_excluded), false) AS scan_excluded
    FROM (
      SELECT
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            -- LIVE excludes Diffusers for every type.
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Diffusers'::text, 'Core ML'::text, 'ONNX'::text])
          )
          -- A failed or unfinished run's Training Data zip has trainingResults but no epochs.
          OR ((mf.metadata -> 'trainingResults'::text -> 'epochs'::text) @> '[{}]'::jsonb) IS TRUE
        ) AS ok_live,
        (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            -- STAGED accepts Diffusers for everything except checkpoints, which the SafeTensor
            -- test below handles separately.
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Core ML'::text, 'ONNX'::text])
          )
          -- A failed or unfinished run's Training Data zip has trainingResults but no epochs.
          OR ((mf.metadata -> 'trainingResults'::text -> 'epochs'::text) @> '[{}]'::jsonb) IS TRUE
        ) AS ok_next,
        -- STAGED only: the loader serves SafeTensor, so a checkpoint without one cannot be loaded.
        (
          mf."scannedAt" IS NOT NULL
          AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
          AND mf.metadata ->> 'format'::text = 'SafeTensor'
        ) AS is_safetensor,
        -- Matches excludedFromCoverage (src/server/utils/failed-scan.ts).
        (
          mf."pickleScanResult" = 'Danger'::"ScanResultCode"
          OR mf."virusScanResult" = 'Danger'::"ScanResultCode"
          OR (
            (mf."pickleScanResult" = 'Error'::"ScanResultCode" OR mf."virusScanResult" = 'Error'::"ScanResultCode")
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
          )
        ) AS scan_excluded
      FROM "ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
    ) files
  ) f ON TRUE

  -- Both rules carry these, so they are stated once: a moderated model is not covered under either,
  -- and neither is a version scan_excluded marks, whatever arm would cover it.
  WHERE m.mode IS NULL
    AND NOT f.scan_excluded
) rules
WHERE covered OR "coveredNext";
