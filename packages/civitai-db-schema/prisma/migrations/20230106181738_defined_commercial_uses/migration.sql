/*
  Warnings:

  - The `allowCommercialUse` column on the `Model` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
BEGIN;
CREATE TYPE "CommercialUse" AS ENUM ('None', 'Image', 'Rent', 'Sell');
COMMIT;

-- Remove referencing views
DROP VIEW "OnDemandRunStrategy";

-- AlterTable
ALTER TABLE "Model" RENAME COLUMN "allowCommercialUse" TO "allowCommercialUse_old";
ALTER TABLE "Model" ADD COLUMN "allowCommercialUse" "CommercialUse" NOT NULL DEFAULT 'Sell';

-- Update data
UPDATE "Model" SET "allowCommercialUse" = 'None' WHERE "allowCommercialUse_old" = FALSE;
ALTER TABLE "Model" DROP COLUMN "allowCommercialUse_old";

-- Create View
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
      (p.personal OR m."allowCommercialUse" = 'Rent' OR m."allowCommercialUse" = 'Sell');


