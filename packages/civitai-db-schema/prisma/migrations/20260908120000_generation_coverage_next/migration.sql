-- GenerationCoverageNext — the paid-model-loading coverage rule, staged alongside the live view.
--
-- 🔴 NOT named "GenerationCoverage2": that view ALREADY EXISTS in production. It is a stale earlier
-- experiment — hardcoded base-model list instead of the GenerationBaseModel table, a wider licence
-- array (RentCivit/Rent/Sell), still carrying CoveredCheckpoint, no ExternalGeneration branch, an
-- older file-type list. Nothing in this repo reads it and no database object depends on it, but
-- CREATE OR REPLACE on that name would have silently overwritten it. Whether to drop it is a
-- separate question for whoever left it there.
--
-- Read by the paid-load path only: resource-load.service's eligibility gate, and the mini
-- model-version endpoint the orchestrator reads. Every other caller still reads
-- `GenerationCoverage`, which is untouched.
--
-- Deliberately NOT added to schema.full.prisma. The cutover plan is to replace
-- `GenerationCoverage`'s own definition with this body and drop this view, at which point the
-- Prisma model needs no change at all. Adding a second mapped model would create client churn that
-- the cutover then has to undo.
--
-- Two changes from `GenerationCoverage`, and only two:
--
--   1. The checkpoint branch no longer requires membership in `CoveredCheckpoint`. That table is
--      the weekly auction's residency proxy — it is written and pruned by handle-auctions.ts, so a
--      checkpoint someone paid to load would lose coverage at the next auction run. Paid loading
--      replaces it. Measured 2026-09-08: 638 -> 33,796 covered checkpoints.
--
--   2. 'Diffusers' is removed from the excluded file formats. Confirmed loadable by the
--      orchestrator (Justin, 2026-09-08). ~675 added rows across all types. 'Core ML' and 'ONNX'
--      stay excluded — they are inference-runtime formats, not servable weights.
--
-- Deliberately UNCHANGED:
--
--   * The `EcosystemCheckpoints` branch. It is not a loophole: it is the generator's default model
--     per ecosystem, and 62 of the 63 checkpoint defaults are covered through it while ZERO are
--     covered through `CoveredCheckpoint`. Removing it would strip the default model from half the
--     supported ecosystems.
--   * The `usageControl = 'ExternalGeneration'` branch, which covers file-less API models. There is
--     nothing to download for these, so they are covered but must never be offered a paid load.
--   * `baseModel IN GenerationBaseModel` — the base models where the orchestrator has extended
--     checkpoint/diffuser support. Loading supports only these (Justin, 2026-09-08).
--   * The `RentCivit` licence gate. Zero covered versions lack it today; the purchase path refuses
--     anything not in coverage, which inherits this rule rather than restating it.
--
-- ⚠️ AFTER THE CUTOVER, `covered` MEANS SOMETHING DIFFERENT. Today, for checkpoints, it effectively
-- means "resident in the cluster" because the auction put them there. Here it means only "allowed
-- to generate"; residency becomes a separate axis reported by the orchestrator. Every existing
-- reader that treats `covered` as "will generate right now" is correct today and wrong after.
-- That audit must happen before anything is repointed.
--
-- See docs/features/paid-model-loading-coverage.md.

CREATE OR REPLACE VIEW "GenerationCoverageNext" AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  true AS covered
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE
  -- Branch 1: the generator's per-ecosystem default models.
  mv.id IN (SELECT "EcosystemCheckpoints".id FROM "EcosystemCheckpoints")

  -- Branch 2: file-less external/API generation. Covered, never loadable.
  OR (
    mv."usageControl" = 'ExternalGeneration'::"ModelUsageControl"
    AND mv.status = 'Published'::"ModelStatus"
    AND NOT m.poi
  )

  -- Branch 3: the ordinary path — licensed, scanned, on a supported base model.
  OR (
    NOT m.poi
    AND (
      mv.status = 'Published'::"ModelStatus"
      OR m.availability = 'Private'::"Availability"
      OR m."uploadType" = 'Trained'::"ModelUploadType"
    )
    AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse"]
    AND EXISTS (
      SELECT 1
      FROM "ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
        AND (
          (
            mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            -- CHANGE 2: 'Diffusers' removed from this exclusion list.
            AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Core ML'::text, 'ONNX'::text])
          )
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
        )
    )
    AND (
      mv."baseModel" IN (SELECT "GenerationBaseModel"."baseModel" FROM "GenerationBaseModel")
      OR m.type = 'Upscaler'::"ModelType"
    )
    AND (
      -- CHANGE 1: the `AND mv.id IN (SELECT version_id FROM "CoveredCheckpoint")` conjunct that
      -- used to sit here is gone. Any standard checkpoint on a supported base model now qualifies.
      (m.type = 'Checkpoint'::"ModelType" AND mv."baseModelType" = 'Standard')
      OR m.type = ANY (ARRAY['LORA'::"ModelType", 'TextualInversion'::"ModelType", 'VAE'::"ModelType", 'LoCon'::"ModelType", 'DoRA'::"ModelType"])
      OR m.type = 'Upscaler'::"ModelType"
    )
  );
