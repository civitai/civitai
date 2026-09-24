-- GenerationCoverageNext — a checkpoint must carry a SafeTensor weight file.
--
-- Replaces the body created by 20260908120000_generation_coverage_next. One conjunct changes; the
-- rest is reproduced verbatim so the view has a single readable definition.
--
-- WHY: paid model loading serves a checkpoint by loading its weights on demand, and the cluster
-- loads SafeTensor only. A checkpoint with no SafeTensor file therefore cannot generate at all —
-- so `covered` must be false for it, not merely "covered but never offered a load". That is what
-- puts this in the view rather than in `hasLoadableFile` alone: the model detail page's Create
-- button reads `canGenerate`, which composes this view.
--
-- 🔴 SCOPED TO CHECKPOINTS ON PURPOSE. The condition sits on the checkpoint disjunct, NOT on the
-- shared `EXISTS` above it, because loading is a checkpoint-only feature. Putting it in the shared
-- clause would apply it to every type, and measured on 2026-09-09 that removes 3,287 covered
-- textual inversions carrying 1.39 BILLION lifetime generations — more than every SafeTensor TI
-- combined. Embeddings ship as `.pt` (PickleTensor), are not served by the loader, and generate
-- fine. LoRA/LoCon/DoRA/VAE/Upscaler are untouched for the same reason.
--
-- COST, measured 2026-09-09 against the production replica:
--   * 2,242 covered checkpoint versions lose coverage (33,811 -> 31,569; total view rows 933,851 -> 931,609,
--     every row of the delta a checkpoint; textual inversions unchanged at 6,299 and all 514
--     auction rows retained)
--   * 834 of them have any generation history; 6.5M lifetime generations, 0.43% of all checkpoint
--     generation (SafeTensor checkpoints: 30,481 versions, 1,491M generations)
--   * by format, and these OVERLAP — a version can carry several files, so they sum above 2,242:
--     ~1,753 PickleTensor, ~938 GGUF, ~174 Diffusers, ~167 Other, ~7 unset, 6 `pt`
--
-- ⚠️ THIS REVERSES PART OF "CHANGE 2" IN THE PREVIOUS MIGRATION. Diffusers was ruled loadable
-- (Justin, 2026-09-08) and removed from the excluded-format list. "SafeTensor only" excludes it
-- again for CHECKPOINTS — 174 versions. Diffusers remains accepted for every other type, because
-- the shared `EXISTS` is unchanged. Recorded here rather than silently overwritten.
--
-- An ALLOW-list, not the deny-list the shared clause uses, and the difference is load-bearing:
-- `format` is free text (six rows carry `pt`, which no enum defines) and is frequently unset, so
-- `<> ALL (...)` cannot promise SafeTensor. `= 'SafeTensor'` is null-safe by construction — an
-- unset format fails, which is the intended direction here and the opposite of the clause above.
--
-- CHANGE 1 IS PARTLY WALKED BACK, DELIBERATELY AND TEMPORARILY. The previous migration dropped
-- `CoveredCheckpoint` — the weekly auction's residency list — entirely. It returns here as a
-- DISJUNCT rather than the conjunct it used to be: auction membership no longer decides coverage,
-- it only excuses a checkpoint from the SafeTensor requirement, because the auction has already
-- made it resident and a resident checkpoint needs no load to generate.
--
-- Measured 2026-09-09: `CoveredCheckpoint` holds 514 rows, all 514 already covered, all holding
-- RentCivit, all on supported base models — and exactly 6 lacking a SafeTensor file. So this
-- rescues 6 versions and changes nothing else. It is scaffolding for the auction's retirement;
-- delete this disjunct when the auction stops writing that table.
--
-- Branch 1 (`EcosystemCheckpoints`) still bypasses this, as it bypasses the file check entirely.
-- Those are the generator's own per-ecosystem defaults; leaving them is the existing deliberate
-- choice, not an oversight.
--
-- 🔴 NARROWING TAKES EFFECT THE MOMENT THIS RUNS. Unlike an additive change there is no safe
-- window: apply it when the readers of `covered` are ready for 2,242 fewer checkpoints.
--
-- `checkLoadable` in src/server/services/resource-load.service.ts applies the same checkpoint-scoped
-- SafeTensor rule at purchase time with a specific reason — except it has no CoveredCheckpoint
-- escape, so the 6 versions rescued here are still refused there. Correct: they are resident, so
-- they generate without a load. See docs/features/paid-model-loading-coverage.md.

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
