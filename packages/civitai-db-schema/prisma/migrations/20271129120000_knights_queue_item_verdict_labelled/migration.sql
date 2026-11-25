-- The settled value the Knights label pass last recorded as a verdict label in the label store, so the pass reads only
-- items whose verdict is not recorded yet (or changed since). Nullable with no default: adding it rewrites nothing.
--
-- MANUAL APPLY, per environment, before deploying the Knights build that reads it. Then apply
-- 20271129120100_knights_queue_item_verdict_unlabelled_idx.
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "verdictLabelledValue" TEXT;
