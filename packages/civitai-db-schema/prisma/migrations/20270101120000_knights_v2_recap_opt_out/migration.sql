-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: the recap popup reads and writes this column.
ALTER TABLE "KnightsPlayer" ADD COLUMN IF NOT EXISTS "recapPopupOptOut" BOOLEAN NOT NULL DEFAULT false;
