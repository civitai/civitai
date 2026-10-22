-- Moderator app, Models -> Model Flags, Flagged tab: lists models whose text scan raised a minor or
-- real-person flag that no moderator has ruled on. The queue, its count and the sidebar badge all
-- filter "Model" on the predicate below, which nothing indexes today: on a table of ~1M rows each
-- page load is a parallel seq scan of about 1 s. The partial index keeps the queries as written; they
-- repeat the predicate verbatim, which a partial index on a jsonb `?` test requires.
--
-- The index also covers models whose flag was already ruled on (the entry keeps its workflowId), so it
-- is larger than the live queue but still a small fraction of the table.
--
-- HAND-APPLIED. CONCURRENTLY, so apply outside a transaction. Safe to apply before or after the release.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_textScanFlagged_idx" ON "Model" (id)
  WHERE (meta->'textScanFlags'->'minor' ? 'workflowId'
      OR meta->'textScanFlags'->'poi' ? 'workflowId');
