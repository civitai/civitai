-- Public challenges v1: schema foundations for user-created challenges.
-- Adds entry-fee funding, participant cap, judging categories, and scan gating,
-- and makes Challenge.createdById nullable (SET NULL on creator deletion) so a live
-- user challenge is not cascade-deleted along with its owner's account
-- (mirrors the ChallengeEvent.createdById treatment).
--
-- Per repo convention, migrations are applied MANUALLY (no `prisma migrate deploy`).
-- "ChallengeScanStatus" is a brand-new type, so creating and using it in the same
-- migration is safe (unlike ADD VALUE on an existing enum).

CREATE TYPE "ChallengeScanStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error');

-- New columns. scanStatus defaults to 'Scanned' so existing + system/mod challenges
-- stay publicly visible without a backfill blackout; the user-create path sets 'Pending'.
ALTER TABLE "Challenge"
  ADD COLUMN "judgingCategories" JSONB,
  ADD COLUMN "maxParticipants"   INTEGER,
  ADD COLUMN "entryFee"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scanStatus"        "ChallengeScanStatus" NOT NULL DEFAULT 'Scanned',
  ADD COLUMN "scannedAt"         TIMESTAMP(3);

-- Make createdById nullable and switch the FK from ON DELETE CASCADE to SET NULL.
ALTER TABLE "Challenge" DROP CONSTRAINT "Challenge_createdById_fkey";
ALTER TABLE "Challenge" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Public feed can exclude non-Scanned challenges efficiently.
CREATE INDEX "Challenge_status_scanStatus_idx" ON "Challenge" ("status", "scanStatus");
