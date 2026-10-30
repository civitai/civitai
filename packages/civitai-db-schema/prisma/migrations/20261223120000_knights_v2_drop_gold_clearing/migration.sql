-- Idempotent: applied by hand, possibly more than once.
-- Deploy order: deploy the main app and the Knights app builds that no longer read or write these tables or
-- "NewOrderPlayer"."goldCleared" first (gold is convertible as soon as it is earned), then apply this migration.
-- Applying it earlier breaks the previous builds, which still read "goldCleared" and write "KnightsDetectionRun".
-- Dropping the tables drops their indexes; the partial index on "NewOrderPlayer" goes with its column, and is dropped by name first.

DROP INDEX IF EXISTS "NewOrderPlayer_uncleared_gold_idx";
ALTER TABLE "NewOrderPlayer" DROP COLUMN IF EXISTS "goldCleared";

DROP TABLE IF EXISTS "KnightsGoldClearing";
DROP TABLE IF EXISTS "KnightsDetectionRun";
