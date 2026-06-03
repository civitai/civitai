-- Backfill Model.lastVersionAt for any rows that were poisoned with a future
-- timestamp (e.g. from a Scheduled→Published transition that left publishedAt
-- in the future). Recomputes from the latest Published version with a
-- non-future publishedAt, matching the post-fix `updateModelLastVersionAt`
-- behavior. The trg_sync_model_to_metric trigger propagates the corrected
-- value into ModelMetric.lastVersionAt automatically.
--
-- Setting lastVersionAt back to NULL when no eligible Published version
-- exists is intentional: it matches the `if (!modelVersion) return;`
-- short-circuit in the application path and keeps the model out of the
-- Newest feed until a real publish exists.

UPDATE "Model" m
SET "lastVersionAt" = (
  SELECT MAX(mv."publishedAt")
  FROM "ModelVersion" mv
  WHERE mv."modelId" = m.id
    AND mv.status = 'Published'
    AND mv."publishedAt" IS NOT NULL
    AND mv."publishedAt" <= NOW()
)
WHERE m."lastVersionAt" > NOW();
