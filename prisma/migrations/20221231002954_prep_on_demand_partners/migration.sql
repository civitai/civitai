-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "allowCommercialUse" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowDerivatives" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowDifferentLicense" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowNoCredit" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "onDemandStrategy" TEXT,
ADD COLUMN     "personal" BOOLEAN NOT NULL DEFAULT false;

-- View
CREATE VIEW "OnDemandRunStrategy" AS
SELECT
  p.id "partnerId",
  mv.id "modelVersionId",
  REPLACE(
    REPLACE(p."onDemandStrategy", '{downloadUrl}', 'https://civitai.com/api/download/models/{modelVersionId}'),
    '{modelVersionId}'::text, mv.id::text
  ) "url"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId" AND m.type = 'Checkpoint' AND m.status = 'Published'
JOIN "Partner" p ON p."onDemand" = TRUE AND p."onDemandStrategy" IS NOT NULL
WHERE (p.nsfw = TRUE OR m.nsfw = FALSE) AND
      (p.poi = TRUE OR m.poi = FALSE) AND
      (p.personal OR m."allowCommercialUse" = TRUE);