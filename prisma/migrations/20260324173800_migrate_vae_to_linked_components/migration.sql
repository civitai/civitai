-- Migrate existing vaeId references to RecommendedResource (linked components)
-- This creates a linked component record for every ModelVersion with a non-null vaeId
INSERT INTO "RecommendedResource" ("resourceId", "sourceId", "settings")
SELECT
  mv."vaeId" AS "resourceId",
  mv.id AS "sourceId",
  jsonb_build_object(
    'isLinkedComponent', true,
    'componentType', 'VAE',
    'fileId', pf.id,
    'modelId', vm."modelId",
    'modelName', m.name,
    'versionName', vm.name,
    'fileName', pf.name,
    'isRequired', false
  )
FROM "ModelVersion" mv
-- Join to the VAE ModelVersion to get its name and modelId
JOIN "ModelVersion" vm ON vm.id = mv."vaeId"
-- Join to the VAE's parent Model for the model name
JOIN "Model" m ON m.id = vm."modelId"
-- Get the primary file (type = 'Model') for the VAE version
LEFT JOIN LATERAL (
  SELECT mf.id, mf.name
  FROM "ModelFile" mf
  WHERE mf."modelVersionId" = mv."vaeId" AND mf.type = 'Model'
  ORDER BY mf.id ASC
  LIMIT 1
) pf ON true
WHERE mv."vaeId" IS NOT NULL
  -- Skip VAE versions with no files
  AND pf.id IS NOT NULL
  -- Skip if a linked component already exists for this source+target pair (idempotent)
  AND NOT EXISTS (
    SELECT 1 FROM "RecommendedResource" rr
    WHERE rr."sourceId" = mv.id
      AND rr."resourceId" = mv."vaeId"
      AND rr.settings->>'isLinkedComponent' = 'true'
  );
