ALTER TABLE "Model" ADD COLUMN "allowCommercialUse_temp" "CommercialUse"[] NOT NULL DEFAULT ARRAY['Image', 'RentCivit', 'Rent', 'Sell']::"CommercialUse"[];

UPDATE "Model" SET "allowCommercialUse_temp" = CASE
  WHEN "allowCommercialUse" = 'Image' THEN ARRAY['Image']::"CommercialUse"[]
  WHEN "allowCommercialUse" = 'RentCivit' THEN ARRAY['Image', 'RentCivit']::"CommercialUse"[]
  WHEN "allowCommercialUse" = 'Rent' THEN ARRAY['Image', 'RentCivit', 'Rent']::"CommercialUse"[]
  WHEN "allowCommercialUse" = 'Sell' THEN ARRAY['Image', 'RentCivit', 'Rent', 'Sell']::"CommercialUse"[]
  ELSE ARRAY[]::"CommercialUse"[]
END;

-- Drop dependent views
DROP VIEW IF EXISTS "GenerationCoverage";
DROP VIEW IF EXISTS "OnDemandRunStrategy";

-- Replace temp column
ALTER TABLE "Model" DROP COLUMN "allowCommercialUse";
ALTER TABLE "Model" RENAME COLUMN "allowCommercialUse_temp" TO "allowCommercialUse";

-- Recreate views
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
  AND m."allowCommercialUse" && ARRAY['RentCivit', 'Rent', 'Sell']::"CommercialUse"[];

CREATE OR REPLACE VIEW "OnDemandRunStrategy" AS
SELECT
  p.id "partnerId",
  mv.id "modelVersionId",
  REPLACE(
    REPLACE(p."onDemandStrategy", '{downloadUrl}', 'https://civitai.com/api/download/models/{modelVersionId}'),
    '{modelVersionId}'::text, mv.id::text
  ) "url"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId" AND m.status = 'Published'
JOIN "Partner" p ON p."onDemand" = TRUE AND p."onDemandStrategy" IS NOT NULL AND m.type = ANY(p."onDemandTypes")
WHERE (p.nsfw = TRUE OR m.nsfw = FALSE) AND
      (p.poi = TRUE OR m.poi = FALSE) AND
      (p.personal OR m."allowCommercialUse" && ARRAY['Rent', 'Sell']::"CommercialUse"[]);
