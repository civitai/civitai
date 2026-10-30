-- Idempotent: applied by hand, possibly more than once.
-- Deploy order: deploy the Knights app first (it no longer reads "goldCleared" or detection runs; the previous main app's
-- reset still zeroes "goldEarned", so convertible gold stays correct), then the main app (no longer writes
-- "KnightsDetectionRun" or resets "goldCleared"), then apply this migration. Applying it earlier breaks the previous builds.
-- Dropping the tables drops their indexes; the partial index on "NewOrderPlayer" is dropped by name before its column.

DROP INDEX IF EXISTS "NewOrderPlayer_uncleared_gold_idx";
ALTER TABLE "NewOrderPlayer" DROP COLUMN IF EXISTS "goldCleared";

DROP TABLE IF EXISTS "KnightsGoldClearing";
DROP TABLE IF EXISTS "KnightsDetectionRun";
