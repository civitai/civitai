-- Honour the creator's "Run on Civitai" permission in generation coverage.
--
-- The permission clause was an any-of overlap across RentCivit, Rent and Sell, so a creator who
-- withheld RentCivit while leaving Rent or Sell set still got a working Create button — and on
-- SD 1.5 / SDXL 1.0 the model page published the licence addendum "Do not run the Model on the
-- Civitai platform for generation" beside it. Coverage now requires RentCivit specifically.
--
-- APPLY ORDER — all four steps, in this order:
--
--   1. DEPLOY the release carrying the corrected `@default([Image, RentCivit, Rent, Sell])`. The
--      old default is what production writes until then, so a view swapped in ahead of the deploy
--      leaves every newly-trained LoRA uncovered the moment it is created.
--   2. RUN /api/admin/temp/backfill-trained-model-permissions?action=repair. Those models carry a
--      defaulted `{Sell}` rather than a creator's choice; without this, applying the view removes
--      ~65,000 of them from the generator on a permission nobody set.
--   3. APPLY this migration.
--   4. PURGE both caches that store `covered`, and run ?action=reindex:
--        packed:generation:resource-data-3  (resourceDataCache, TTL 1h) — this is the one the
--          generator itself reads; `generation.service.ts` rejects on `!x.covered`, so a version
--          that just lost coverage stays generatable for up to an hour without this.
--        packed:caches:data-for-model       (dataForModelsCache, TTL 1d) — the model page's
--          Create button.
--      ?action=reindex queues the uncovered models into the search index, which otherwise keeps
--      serving canGenerate: true for them under the on-site-generation filter.
--
-- The two branches above the catch-all are deliberately untouched: EcosystemCheckpoints and
-- ExternalGeneration are mod-curated routes onto first-party engines, not creator-licensed weights.

-- REPLACE, not DROP + CREATE: only the WHERE clause moves and the output columns keep their names,
-- types and order, so REPLACE is legal and leaves no window in which the view does not exist.
--
-- GenerationCoverage is on the hot read path (resource-data.redis.ts, caches.ts, model.service.ts,
-- v1/model-versions/mini/[id].ts), and REPLACE still takes ACCESS EXCLUSIVE. lock_timeout bounds
-- the wait so one long-running reader makes this abort rather than queueing every generation read
-- behind it - and it must be SET LOCAL inside the transaction, because applied by hand through a
-- client that opens a connection per statement a bare `SET` lands in a session the REPLACE never
-- sees, leaving it to wait forever under the server default.
--
-- The transaction is safe here in a way it would not be around a DROP: if the BEGIN is autocommitted
-- on its own, nothing has been taken away, and the REPLACE either lands whole or not at all.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE VIEW "GenerationCoverage"("modelId", "modelVersionId", covered) AS
SELECT
  m.id AS "modelId",
  mv.id AS "modelVersionId",
  TRUE AS covered
FROM
  "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
WHERE
  -- ========================================
  -- Ecosystem checkpoints: curated, always covered
  -- ========================================
  mv.id IN (SELECT id FROM "EcosystemCheckpoints")

  -- ========================================
  -- External generation: file-less mod-published versions routed via external
  -- engines (e.g. NanoBanana, Seedream). Normal users can generate with these
  -- via the dedicated engine UIs; canGenerate is unrestricted.
  -- The NOT m.poi guard mirrors the catch-all branch so PoI models can't be
  -- silently flipped into a covered/generatable state via the usageControl flag.
  -- ========================================
  OR (mv."usageControl" = 'ExternalGeneration' AND mv.status = 'Published' AND NOT m.poi)

  -- ========================================
  -- Everything else: shared conditions + type-specific logic
  -- ========================================
  OR (
    NOT m.poi
    AND (mv.status = 'Published'::"ModelStatus"
      OR m.availability = 'Private'::"Availability"
      OR m."uploadType" = 'Trained'::"ModelUploadType")
    AND m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse"]
    AND EXISTS (
      SELECT 1
      FROM "ModelFile" mf
      WHERE mf."modelVersionId" = mv.id
        AND (
          (mf."scannedAt" IS NOT NULL
            AND mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Diffusion Model'::text, 'UNet'::text, 'Negative'::text, 'VAE'::text])
            AND COALESCE(mf.metadata ->> 'format', '') NOT IN ('Diffusers', 'Core ML', 'ONNX'))
          OR (mf.metadata -> 'trainingResults') IS NOT NULL
        )
    )
    -- Base model must be in GenerationBaseModel (for non-upscaler types)
    AND (mv."baseModel" IN (SELECT "baseModel" FROM "GenerationBaseModel")
      OR m.type = 'Upscaler'::"ModelType")
    -- Type-specific coverage
    AND (
      -- Checkpoints: Standard type + in CoveredCheckpoint
      (m.type = 'Checkpoint'::"ModelType"
        AND mv."baseModelType" = 'Standard'::text
        AND mv.id IN (SELECT version_id FROM "CoveredCheckpoint"))
      -- Addon types
      OR m.type IN (
          'LORA'::"ModelType",
          'TextualInversion'::"ModelType",
          'VAE'::"ModelType",
          'LoCon'::"ModelType",
          'DoRA'::"ModelType")
      -- Upscalers: ecosystem-independent
      OR m.type = 'Upscaler'::"ModelType"
    )
  );

COMMIT;
