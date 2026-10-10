-- The moderator app's Model rules "Matches" list pages the ModelRules verdicts that matched, newest
-- first. Without this, every page reads every ModelRules row (one per scanned public model). Only
-- matching verdicts enter the index, so it stays small. The query in
-- apps/moderator/src/lib/server/model-rules.service.ts repeats this predicate as literals; keep them
-- in step. Not needed before ModelRules has rows, so it can be applied any time before shadow mode.
-- CONCURRENTLY: run outside a transaction.
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid, and if false, DROP INDEX CONCURRENTLY and run this again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EntityModeration_modelRules_matches_idx"
  ON "EntityModeration" ("updatedAt" DESC, id DESC)
  WHERE "entityType" IN ('ModelRules', 'ModelRules:shadow')
    AND status = 'Succeeded'
    AND 'modelRules' = ANY("triggeredLabels");
