-- CreateTable
CREATE TABLE "GenerationBaseModel"(
  "baseModel" text NOT NULL,
  CONSTRAINT "GenerationBaseModel_pkey" PRIMARY KEY ("baseModel")
);

INSERT INTO "GenerationBaseModel"("baseModel")
  VALUES ('Wan Video'),
('Hunyuan Video'),
('SD 1.5'),
('SD 1.4'),
('SD 1.5 LCM'),
('SDXL 0.9'),
('SDXL 1.0'),
('SDXL 1.0 LCM'),
('Pony'),
('Flux.1 D'),
('Illustrious'),
('SD 3.5'),
('SD 3.5 Medium'),
('SD 3.5 Large'),
('SD 3.5 Large Turbo'),
('NoobAI');

DROP VIEW "GenerationCoverage";

CREATE VIEW "GenerationCoverage"("modelId", "modelVersionId", covered) AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  TRUE AS covered
FROM
  "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
WHERE (mv.id IN (
    SELECT
      "EcosystemCheckpoints".id
    FROM
      "EcosystemCheckpoints"))
  OR (mv."baseModel" IN (
      SELECT
        *
      FROM
        "GenerationBaseModel"))
  AND NOT m.poi
  AND (mv.status = 'Published'::"ModelStatus"
    OR m.availability = 'Private'::"Availability"
    OR m."uploadType" = 'Trained'::"ModelUploadType")
  AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse", 'Rent'::"CommercialUse", 'Sell'::"CommercialUse"]
  AND (m.type = 'Checkpoint'::"ModelType"
    AND mv."baseModelType" = 'Standard'::text
    AND (mv.id IN (
        SELECT
          "CoveredCheckpoint".version_id
        FROM
          "CoveredCheckpoint"))
      OR m.type = 'LORA'::"ModelType"
      OR m.type = 'TextualInversion'::"ModelType"
      OR m.type = 'VAE'::"ModelType"
      OR m.type = 'LoCon'::"ModelType"
      OR m.type = 'DoRA'::"ModelType")
  AND (EXISTS (
      SELECT
        1
      FROM
        "ModelFile" mf
      WHERE
        mf."modelVersionId" = mv.id
        AND (mf."scannedAt" IS NOT NULL
          AND (mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Negative'::text, 'VAE'::text]))
          OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL)));

