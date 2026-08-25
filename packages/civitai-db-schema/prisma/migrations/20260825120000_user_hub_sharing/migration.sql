-- Hub sharing. Both columns are additive with defaults, so every existing hub stays
-- private and uncapped without a backfill.
ALTER TABLE "UserHub" ADD COLUMN "availability" "Availability" NOT NULL DEFAULT 'Private';
ALTER TABLE "UserHub" ADD COLUMN "forcedBrowsingLevel" INTEGER NOT NULL DEFAULT 0;
