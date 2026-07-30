-- Supports the `model-flagged-minor` notification poll and the moderator
-- Auto-flagged queue, both of which filter on the snapshot's source.
-- CONCURRENTLY cannot run inside a transaction block; apply it on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Model_minorFlagSnapshot_source_idx"
  ON "Model" (((meta->'minorFlagSnapshot'->>'source')))
  WHERE meta ? 'minorFlagSnapshot';
