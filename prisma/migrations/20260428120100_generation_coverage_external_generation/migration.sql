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
  -- ========================================
  OR (mv."usageControl" = 'ExternalGeneration' AND mv.status = 'Published')

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
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Negative'::text, 'VAE'::text]))
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
