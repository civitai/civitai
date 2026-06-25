-- Exclude zip-packaged model formats (Diffusers, Core ML, ONNX) from the
-- GenerationCoverage "version has scanned primary weights" check.
--
-- Generation engines require single-file weights (SafeTensor, PickleTensor,
-- GGUF, etc.). Diffusers/Core ML/ONNX are uploaded as a single .zip archive
-- containing a directory structure and cannot be used for generation.
--
-- The previous view only filtered on ModelFile.type. A zip uploaded with
-- type='Model' (e.g. a Diffusers LoRA) passed the allowlist and was marked
-- covered, which surfaced a non-functional "Create" button on the model page.
-- We now additionally require that the file's metadata.format is not one of
-- the zip-packaged formats. These mirror `zipModelFileTypes` in
-- src/server/common/constants.ts.
--
-- The trainingResults branch is intentionally left untouched: trained models
-- ship single-file safetensors weights and remain generatable. A version that
-- has BOTH a zip and a real single-file weight also stays covered (it has
-- usable weights); only zip-only versions lose coverage.

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
    AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse", 'Rent'::"CommercialUse", 'Sell'::"CommercialUse"]
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
