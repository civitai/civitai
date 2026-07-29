-- ============================================================
-- Challenge tracking — ChallengeEngagement
-- ============================================================
-- Per-user "notify me" rows for a challenge. Drives challenge-starting,
-- challenge-ending-soon and challenge-results. Entrants are NOT stored here —
-- they are derived at send time from CollectionItem on the challenge collection.
--
-- ⚠️ MANUAL APPLY — this repo does NOT run `prisma migrate deploy`. This file is
-- committed for HISTORY ONLY; a HUMAN applies the SQL below per environment
-- (psql / retool). Apply to preview, staging and prod before the code ships, or
-- every tracking query errors.
--
-- Idempotent: IF NOT EXISTS guards throughout, so a manual re-run is a no-op.
-- The table is brand-new and EMPTY, so plain CREATE INDEX takes no meaningful
-- lock — CONCURRENTLY is unnecessary (and cannot run inside a transaction).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChallengeEngagementType') THEN
    CREATE TYPE "ChallengeEngagementType" AS ENUM ('Notify');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "ChallengeEngagement" (
  "userId"      INTEGER NOT NULL,
  "challengeId" INTEGER NOT NULL,
  "type"        "ChallengeEngagementType" NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChallengeEngagement_pkey" PRIMARY KEY ("type", "challengeId", "userId")
);

CREATE INDEX IF NOT EXISTS "ChallengeEngagement_challengeId_idx"
  ON "ChallengeEngagement"("challengeId");

CREATE INDEX IF NOT EXISTS "ChallengeEngagement_userId_idx"
  ON "ChallengeEngagement" USING HASH ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChallengeEngagement_userId_fkey'
  ) THEN
    ALTER TABLE "ChallengeEngagement"
      ADD CONSTRAINT "ChallengeEngagement_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChallengeEngagement_challengeId_fkey'
  ) THEN
    ALTER TABLE "ChallengeEngagement"
      ADD CONSTRAINT "ChallengeEngagement_challengeId_fkey"
      FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
