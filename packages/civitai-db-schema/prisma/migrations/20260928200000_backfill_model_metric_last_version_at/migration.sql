-- Re-sync ModelMetric."lastVersionAt" rows that sync_model_to_metric skipped.
--
-- The trigger only copies a Model."lastVersionAt" that is <= NOW(). The scheduled-publishing
-- job wrote the app server's clock, which could read ahead of the database's, so the copy was
-- dropped and the model fell out of the Newest feed and profile listings until republished.
-- Idempotent: touches only rows that still disagree with Model.
UPDATE "ModelMetric" mm
SET "lastVersionAt" = m."lastVersionAt"
FROM "Model" m
WHERE m.id = mm."modelId"
  AND m."lastVersionAt" IS NOT NULL
  AND m."lastVersionAt" <= NOW()
  AND mm."lastVersionAt" IS DISTINCT FROM m."lastVersionAt";
