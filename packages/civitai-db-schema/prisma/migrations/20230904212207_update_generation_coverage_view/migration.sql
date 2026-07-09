CREATE OR REPLACE VIEW "GenerationCoverage" as
SELECT
  m.id "modelId",
  mv.id "modelVersionId",
  true "covered"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv."baseModel" IN ('SD 1.5')
  AND (
         mv."baseModelType" IN ('Standard')
      OR m.type = 'LORA' AND mv."baseModelType" IS NULL
  )
  AND m."allowCommercialUse" IN ('Rent', 'Sell');
