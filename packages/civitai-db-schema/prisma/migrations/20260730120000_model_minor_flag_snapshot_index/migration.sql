-- Supports the moderator Auto-flagged queue, which filters on the snapshot's source,
-- and the `model-flagged-minor` notification poll, which filters on
-- COALESCE(confirmedFrom, source) and relies on the `meta ? 'minorFlagSnapshot'`
-- clause in that query (not this index's key) to satisfy the partial predicate.
-- CONCURRENTLY cannot run inside a transaction block; apply it on its own.
CREATE INDEX IF NOT EXISTS "Model_minorFlagSnapshot_source_idx"
  ON "Model" (((meta->'minorFlagSnapshot'->>'source')))
  WHERE meta ? 'minorFlagSnapshot';
