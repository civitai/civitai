-- Recreate views
CREATE OR REPLACE VIEW "GenerationCoverage" as
SELECT m.id AS "modelId",
       mv.id AS "modelVersionId",
       TRUE AS covered
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE
  (mv.id = any(ARRAY[699279,1088507,699332,691639,922358]))  -- Flux models
  OR (
    mv."baseModel" = ANY (ARRAY[
      'SD 1.5'::text,
      'SD 1.4'::text,
      'SD 1.5 LCM'::text,
      'SDXL 0.9'::text,
      'SDXL 1.0'::text,
      'SDXL 1.0 LCM'::text,
      'Pony'::text,
      'Flux.1 D'::text,
      'Illustrious'::text,
      'SD 3.5'::text,
      'SD 3.5 Medium'::text,
      'SD 3.5 Large'::text,
      'SD 3.5 Large Turbo'::text
      ])
    AND NOT m.poi
    AND (
      mv.status = 'Published'::"ModelStatus"
      OR m.availability = 'Private'::"Availability"
      OR m."uploadType" = 'Trained'::"ModelUploadType"
    )
    AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse",'Rent'::"CommercialUse",'Sell'::"CommercialUse"]
    AND (
      (
        m.type = 'Checkpoint'::"ModelType"
        AND mv."baseModelType" = 'Standard'::text
        AND mv."baseModel" != 'Flux.1 D'
      )
      OR m.type = 'LORA'::"ModelType"
      OR m.type = 'TextualInversion'::"ModelType"
      OR m.type = 'VAE'::"ModelType"
      OR m.type = 'LoCon'::"ModelType"
      OR m.type = 'DoRA'::"ModelType"
    )
  )
  AND (EXISTS(
    SELECT 1
    FROM "ModelFile" mf
    WHERE
      mf."modelVersionId" = mv.id
      AND (
        mf."scannedAt" IS NOT NULL AND (mf.type = ANY (ARRAY['Model'::text,'Pruned Model'::text,'Negative'::text,'VAE'::text]))
        OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
      )
  ));