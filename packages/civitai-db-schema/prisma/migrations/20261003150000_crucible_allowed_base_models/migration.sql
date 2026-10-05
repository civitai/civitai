-- Apply BEFORE deploying the code that reads it: additive, and the previous client never selects it.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "allowedBaseModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
