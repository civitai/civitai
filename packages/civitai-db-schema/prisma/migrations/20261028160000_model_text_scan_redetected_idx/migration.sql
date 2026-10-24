-- Models with a text-scan re-detection waiting on a moderator (Model.meta.textScanFlags[label].redetected).
-- The moderator app's Re-detected queue reads this set; without the index that is a seq scan of "Model".
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the queue is correct without it, only slow.
--
-- The predicate must match the queue query text exactly (getRedetectedModels in
-- apps/moderator/src/lib/server/minor-hash.service.ts) for the planner to use it.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Model_textScanRedetected_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_textScanRedetected_idx"
  ON "Model" (id)
  WHERE (meta->'textScanFlags'->'minor' ? 'redetected' OR meta->'textScanFlags'->'poi' ? 'redetected');
