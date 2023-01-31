-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "onDemandTypes" "ModelType"[] DEFAULT ARRAY[]::"ModelType"[];
UPDATE "Partner" SET "onDemandTypes" = array['Checkpoint'::"ModelType"] WHERE "onDemand" = true;

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
      (p.personal OR m."allowCommercialUse" = 'Rent' OR m."allowCommercialUse" = 'Sell');