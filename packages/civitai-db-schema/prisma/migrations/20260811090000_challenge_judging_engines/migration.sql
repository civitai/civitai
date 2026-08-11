-- Pluggable challenge judging engines + the pairwise ladder's own storage.
-- Applied MANUALLY (this repo never runs `prisma migrate deploy`).
--
-- Backwards compatible on its own: every existing challenge defaults to "legacy-absolute", which
-- is the path they already run, and the two new tables are written only by the pairwise engine.

ALTER TABLE "Challenge"
  ADD COLUMN IF NOT EXISTS "judgingEngine" VARCHAR(50) NOT NULL DEFAULT 'legacy-absolute';

CREATE TABLE IF NOT EXISTS "ChallengeEntryStanding" (
  "challengeId" INTEGER NOT NULL,
  "imageId"     INTEGER NOT NULL,
  "userId"      INTEGER NOT NULL,
  "rank"        INTEGER NOT NULL,
  "comparisons" INTEGER NOT NULL DEFAULT 0,
  "winRate"     DOUBLE PRECISION,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChallengeEntryStanding_pkey" PRIMARY KEY ("challengeId", "imageId")
);

CREATE INDEX IF NOT EXISTS "ChallengeEntryStanding_challengeId_rank_idx"
  ON "ChallengeEntryStanding" ("challengeId", "rank");

CREATE TABLE IF NOT EXISTS "ChallengeEntryComparison" (
  "id"               SERIAL NOT NULL,
  "challengeId"      INTEGER NOT NULL,
  "phase"            VARCHAR(20) NOT NULL,
  "imageIdA"         INTEGER NOT NULL,
  "imageIdB"         INTEGER NOT NULL,
  "firstSeatImageId" INTEGER NOT NULL,
  "winnerImageId"    INTEGER,
  "margin"           VARCHAR(20),
  "model"            VARCHAR(200) NOT NULL,
  "rerouted"         BOOLEAN NOT NULL DEFAULT false,
  "perCategory"      JSONB,
  "reason"           TEXT,
  "buzzCost"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChallengeEntryComparison_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChallengeEntryComparison_pair_key"
  ON "ChallengeEntryComparison" ("challengeId", "phase", "imageIdA", "imageIdB", "firstSeatImageId");

CREATE INDEX IF NOT EXISTS "ChallengeEntryComparison_challengeId_phase_idx"
  ON "ChallengeEntryComparison" ("challengeId", "phase");

ALTER TABLE "ChallengeEntryStanding"
  ADD CONSTRAINT "ChallengeEntryStanding_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChallengeEntryComparison"
  ADD CONSTRAINT "ChallengeEntryComparison_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
