-- GenerationCoverageNext — a checkpoint must carry a SafeTensor weight file.
--
-- Replaces the body created by 20260908120000_generation_coverage_next. One conjunct changes; the
-- rest is reproduced verbatim so the view has a single readable definition.
--
-- The rule lives in the VIEW, not in `hasLoadableFile` alone, because the cluster loads SafeTensor
-- only: a checkpoint without one cannot generate at all, so `covered` must be false for it rather
-- than "covered but never offered a load".
--
-- 🔴 SCOPED TO CHECKPOINTS ON PURPOSE — the condition sits on the checkpoint disjunct, not the
-- shared `EXISTS`. Widening it to every type drops thousands of covered embeddings, which ship as
-- PickleTensor and are not served by the loader.
--
-- An ALLOW-list, not the deny-list the shared clause uses, and the difference is load-bearing:
-- `format` is free text and frequently unset, so `<> ALL (...)` cannot promise SafeTensor.
-- `= 'SafeTensor'` is null-safe by construction — an unset format fails, which is the intended
-- direction here and the opposite of the clause above.
--
-- `CoveredCheckpoint` returns as a DISJUNCT, not the conjunct it used to be: auction membership no
-- longer decides coverage, it only excuses a checkpoint from the SafeTensor requirement, because the
-- auction has already made it resident. Scaffolding for the auction's retirement — delete this
-- disjunct when the auction stops writing that table.
--
-- 🔴 NARROWING TAKES EFFECT THE MOMENT THIS RUNS. Unlike an additive change there is no safe
-- window: apply it when the readers of `covered` are ready for fewer covered checkpoints.
--
-- Measured impact, and why each conjunct is scoped as it is:
-- docs/features/paid-model-loading-coverage.md.

CREATE OR REPLACE VIEW "GenerationCoverageNext" AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  true AS covered
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE
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
        AND (
          -- The loader serves SafeTensor only, so a checkpoint without one cannot be loaded...
          EXISTS (
            SELECT 1
            FROM "ModelFile" mf2
            WHERE mf2."modelVersionId" = mv.id
              AND mf2."scannedAt" IS NOT NULL
              AND mf2.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
              AND mf2.metadata ->> 'format'::text = 'SafeTensor'
          )
          -- ...unless the weekly auction already put it in the cluster, in which case it needs no
          -- load to generate. Kept INSIDE the checkpoint disjunct rather than made a fourth
          -- top-level branch, so auction membership still cannot bypass the RentCivit licence, the
          -- supported-base-model list or the scanned-file check the way branches 1 and 2 do.
          OR mv.id IN (SELECT "CoveredCheckpoint".version_id FROM "CoveredCheckpoint")
        )
      )
      OR m.type = ANY (ARRAY['LORA'::"ModelType", 'TextualInversion'::"ModelType", 'VAE'::"ModelType", 'LoCon'::"ModelType", 'DoRA'::"ModelType"])
      OR m.type = 'Upscaler'::"ModelType"
    )
  );
