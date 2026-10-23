-- Models waiting on a moderator for a real-person hash match (Model.meta.poiHashMatch). The moderator
-- app's Needs review queue and its sidebar count read this set; without the index that is a seq scan
-- of "Model".
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod).
-- Additive; the queue is correct without it, only slow.
--
-- The queue repeats this predicate as a literal (poiHashMatchPredicate in
-- apps/moderator/src/lib/server/minor-hash.service.ts) so the planner can use the index.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "Model_poiHashMatch_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_poiHashMatch_idx"
  ON "Model" (id)
  WHERE meta ? 'poiHashMatch';
