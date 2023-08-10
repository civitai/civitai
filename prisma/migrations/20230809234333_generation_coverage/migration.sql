
-- DropForeignKey
ALTER TABLE "ModelVersionGenerationCoverage" DROP CONSTRAINT "ModelVersionGenerationCoverage_modelVersionId_fkey";

-- DropTable
DROP TABLE "ModelVersionGenerationCoverage";

CREATE OR REPLACE VIEW "GenerationCoverage" as
SELECT
  m.id "modelId",
  mv.id "modelVersionId",
  true "covered"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mv."baseModel" IN ('SD 1.5')
  AND mv."baseModelType" IN ('Standard')
  AND m."allowCommercialUse" IN ('Rent', 'Sell');
