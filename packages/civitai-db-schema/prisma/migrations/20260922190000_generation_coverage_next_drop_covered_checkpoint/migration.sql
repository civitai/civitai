-- GenerationCoverageNext — the weekly auction's list no longer excuses a checkpoint from the
-- SafeTensor requirement.
--
-- 20260909180000 kept `CoveredCheckpoint` as a disjunct beside that requirement, reasoning that an
-- auction checkpoint is already resident and so needs no load. Justin's call, 2026-09-22: a
-- checkpoint that meets none of the other qualifications should not be covered, residency or not.
-- Measured by running this body against the production replica, 2026-09-22: 940,120 rows against
-- the live view's 940,125, so 5 versions lose coverage. `CoveredCheckpoint` holds 527 rows; the
-- rest qualify on their own, and 5 more keep coverage through the external-generation branch.
--
-- 🔴 THE DEPLOYED VIEW WAS NOT WHAT EITHER MIGRATION SAID. Production's body carried
-- `m.mode IS NULL` wrapping the whole condition; no migration file has ever contained it, so the
-- view was replaced by hand at some point. It is reproduced below, because dropping it would cover
-- the 3,371 models with a mode set (Archived / TakenDown) — a silent widening in the opposite
-- direction to this change. Apply this file rather than re-applying 20260909180000.
--
-- 🔴 NARROWING TAKES EFFECT THE MOMENT THIS RUNS, as with every change to this view.

CREATE OR REPLACE VIEW "GenerationCoverageNext" AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  true AS covered
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE
  m.mode IS NULL
  AND (
    -- Branch 1: the generator's per-ecosystem default models.
    mv.id IN (SELECT "EcosystemCheckpoints".id FROM "EcosystemCheckpoints")

    -- Branch 2: file-less external/API generation. Covered, never loadable.
    OR (
      mv."usageControl" = 'ExternalGeneration'::"ModelUsageControl"
      AND mv.status = 'Published'::"ModelStatus"
      AND NOT m.poi
    )

    -- Branch 3: the ordinary path — licensed, scanned, on a supported base model.
    OR (
      NOT m.poi
      AND (
        mv.status = 'Published'::"ModelStatus"
        OR m.availability = 'Private'::"Availability"
        OR m."uploadType" = 'Trained'::"ModelUploadType"
      )
      AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse"]
      AND EXISTS (
        SELECT 1
        FROM "ModelFile" mf
        WHERE mf."modelVersionId" = mv.id
          AND (
            (
              mf."scannedAt" IS NOT NULL
              AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
              AND COALESCE(mf.metadata ->> 'format'::text, ''::text) <> ALL (ARRAY['Core ML'::text, 'ONNX'::text])
            )
            OR (mf.metadata -> 'trainingResults'::text) IS NOT NULL
          )
      )
      AND (
        mv."baseModel" IN (SELECT "GenerationBaseModel"."baseModel" FROM "GenerationBaseModel")
        OR m.type = 'Upscaler'::"ModelType"
      )
      AND (
        (
          m.type = 'Checkpoint'::"ModelType"
          AND mv."baseModelType" = 'Standard'
          -- The loader serves SafeTensor only, so a checkpoint without one cannot be loaded.
          AND EXISTS (
            SELECT 1
            FROM "ModelFile" mf2
            WHERE mf2."modelVersionId" = mv.id
              AND mf2."scannedAt" IS NOT NULL
              AND mf2.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
              AND mf2.metadata ->> 'format'::text = 'SafeTensor'
          )
        )
        OR m.type = ANY (ARRAY['LORA'::"ModelType", 'TextualInversion'::"ModelType", 'VAE'::"ModelType", 'LoCon'::"ModelType", 'DoRA'::"ModelType"])
        OR m.type = 'Upscaler'::"ModelType"
      )
    )
  );
