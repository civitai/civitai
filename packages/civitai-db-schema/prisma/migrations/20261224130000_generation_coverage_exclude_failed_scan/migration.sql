-- GenerationCoverage: a version is not covered under either rule when any of its model files has a
-- pickle or virus scan result of 'Danger', or a loadable file (the types ok_live and ok_next accept)
-- has one of 'Error'. Columns and their order are unchanged, so CREATE OR REPLACE applies in place.
--
-- Error is excluded on loadable files although publish and download refuse only Danger: a scanner
-- that errored vouched for nothing, and generation loads the file without a person choosing to. An
-- Error on a file the generator never loads (a config, training data) leaves the version covered.
-- Pending is NOT excluded: it holds files not scanned yet, and trained models' result files.
--
-- Version-level, not per-file: the generator may pick any file of a covered version.
--
-- APPLYING THIS NARROWS COVERAGE THE MOMENT IT RUNS, and coverage is cached. Per writable env:
--   0. Before applying, capture the versions this drops:
--        SELECT DISTINCT gc."modelId", gc."modelVersionId"
--        FROM "GenerationCoverage" gc
--        JOIN "ModelFile" mf ON mf."modelVersionId" = gc."modelVersionId"
--        WHERE mf."pickleScanResult" = 'Danger' OR mf."virusScanResult" = 'Danger'
--          OR ((mf."pickleScanResult" = 'Error' OR mf."virusScanResult" = 'Error')
--              AND mf.type = ANY (ARRAY['Model', 'Pruned Model', 'Diffusion Model', 'UNet', 'Negative', 'VAE']));
--   1. Dry run: this file inside BEGIN; ... ROLLBACK;
--   2. Apply.
--   3. Re-run the step-0 query: it must return no rows. (The schema drift check does not cover views.)
--   4. For the step-0 versions, bust the caches that hold coverage, as
--      20260817200000_generation_coverage_require_rentcivit prescribes: resourceDataCache,
--      the orchestrator model cache (bustMvCache covers it per version), dataForModelsCache, and
--      re-queue the models into the models search index. Also bust the file-pinned AIRs of every
--      file of those versions (bustOrchestratorScannedFileCache): version busts do not reach them.
-- Files whose scan fails or errors later are busted by the scan webhook.

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
