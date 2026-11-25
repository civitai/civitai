-- The Knights label pass's keyset walk over settled items whose verdict label is not recorded yet:
--   ... WHERE "status" = 'Resolved' AND "verdictLabelledValue" IS DISTINCT FROM "resolvedValue"
--   ORDER BY "resolvedAt", "id"
-- Partial, so once the backlog is recorded it holds only the newly settled items.
--
-- MANUAL APPLY, per environment, after 20271129120000_knights_queue_item_verdict_labelled. CONCURRENTLY cannot run
-- inside a transaction, so run this ONE statement on its own. It does not block writes to "KnightsQueueItem".
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check pg_index.indisvalid,
-- and if false run `DROP INDEX CONCURRENTLY IF EXISTS "KnightsQueueItem_verdict_unlabelled_idx"` and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KnightsQueueItem_verdict_unlabelled_idx"
  ON "KnightsQueueItem" ("resolvedAt", "id")
  WHERE "status" = 'Resolved' AND "verdictLabelledValue" IS DISTINCT FROM "resolvedValue";
