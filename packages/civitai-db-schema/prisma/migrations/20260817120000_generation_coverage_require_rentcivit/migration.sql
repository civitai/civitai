-- Honour the creator's "Run on Civitai" permission in generation coverage.
--
-- The permission clause was an any-of overlap across RentCivit, Rent and Sell, so a creator who
-- withheld RentCivit while leaving Rent or Sell set still got a working Create button — and on
-- SD 1.5 / SDXL 1.0 the model page published the licence addendum "Do not run the Model on the
-- Civitai platform for generation" beside it. Coverage now requires RentCivit specifically.
--
-- APPLY ORDER: the trained-model permission backfill
-- (/api/admin/temp/backfill-trained-model-permissions) must run BEFORE this view is replaced.
-- Those models carry a defaulted `{Sell}` rather than a creator's choice, and applying this first
-- removes ~65,000 of them from the generator on a permission nobody set.
--
-- The two branches above the catch-all are deliberately untouched: EcosystemCheckpoints and
-- ExternalGeneration are mod-curated routes onto first-party engines, not creator-licensed weights.

DROP VIEW "GenerationCoverage";

CREATE VIEW "GenerationCoverage"("modelId", "modelVersionId", covered) AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  TRUE AS covered
FROM
  "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
WHERE
  -- ========================================
  -- Ecosystem checkpoints: curated, always covered
  -- ========================================
  mv.id IN (SELECT id FROM "EcosystemCheckpoints")

  -- ========================================
  -- External generation: file-less mod-published versions routed via external
  -- engines (e.g. NanoBanana, Seedream). Normal users can generate with these
  -- via the dedicated engine UIs; canGenerate is unrestricted.
  -- The NOT m.poi guard mirrors the catch-all branch so PoI models can't be
  -- silently flipped into a covered/generatable state via the usageControl flag.
  -- ========================================
  OR (mv."usageControl" = 'ExternalGeneration' AND mv.status = 'Published' AND NOT m.poi)

  -- ========================================
  -- Everything else: shared conditions + type-specific logic
  -- ========================================
  OR (
    NOT m.poi
    AND (mv.status = 'Published'::"ModelStatus"
      OR m.availability = 'Private'::"Availability"
      OR m."uploadType" = 'Trained'::"ModelUploadType")
    AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse"]
    AND EXISTS (
      SELECT 1
      FROM "ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
        AND (
          (mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            AND COALESCE(mf.metadata ->> 'format', '') NOT IN ('Diffusers', 'Core ML', 'ONNX'))
          OR (mf.metadata -> 'trainingResults') IS NOT NULL
        )
    )
    -- Base model must be in GenerationBaseModel (for non-upscaler types)
    AND (mv."baseModel" IN (SELECT "baseModel" FROM "GenerationBaseModel")
      OR m.type = 'Upscaler'::"ModelType")
    -- Type-specific coverage
    AND (
      -- Checkpoints: Standard type + in CoveredCheckpoint
      (m.type = 'Checkpoint'::"ModelType"
        AND mv."baseModelType" = 'Standard'::text
        AND mv.id IN (SELECT version_id FROM "CoveredCheckpoint"))
      -- Addon types
      OR m.type IN (
          'LORA'::"ModelType",
          'TextualInversion'::"ModelType",
          'VAE'::"ModelType",
          'LoCon'::"ModelType",
          'DoRA'::"ModelType")
      -- Upscalers: ecosystem-independent
      OR m.type = 'Upscaler'::"ModelType"
    )
  );
