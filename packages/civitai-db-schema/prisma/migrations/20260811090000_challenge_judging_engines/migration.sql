-- Pluggable challenge judging engines + the pairwise ladder's own storage.
-- Applied MANUALLY (this repo never runs `prisma migrate deploy`).
--
-- Backwards compatible on its own: every existing challenge defaults to "legacy-absolute", which
-- is the path they already run, and the two new tables are written only by the pairwise engine.
--
-- Re-runnable. Everything is IF NOT EXISTS except the two foreign keys, which Postgres has no such
-- form for, so those are wrapped to swallow duplicate_object. A partial apply can be retried whole.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- There is DELIBERATELY no foreign key on "imageId" or "userId". Do not "fix" this:
--
--   * "Image" is one of the largest tables here and takes heavy delete traffic — moderation
--     removals, ban-driven content removal. Every referencing FK adds work to each of those.
--   * Enforcing one would need indexes on "imageId", "imageIdA" and "imageIdB" to avoid a
--     sequential scan of the comparison table on every image delete. Three more indexes on a
--     write-heavy table, to enforce a constraint nothing needs.
--   * Cascading on image delete would destroy the record of what the judge decided, which is the
--     one thing worth keeping when an entry is removed after the fact.
--   * Users are soft-deleted, so a "userId" FK would enforce nothing real.
--   * Orphans are inert: "ChallengeEntryStanding" has no readers outside its own store,
--     replaceStandings rewrites wholesale, and the challenge-level cascade below cleans both
--     tables when a challenge is deleted.
--
-- The failure mode being avoided is the opposite one: CollectionItem declared four cascades the
-- database never had, and 249k orphan rows accumulated behind a constraint everyone assumed was
-- doing something. Declaring nothing and saying why beats declaring something aspirational.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

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

DO $$ BEGIN
  ALTER TABLE "ChallengeEntryStanding"
    ADD CONSTRAINT "ChallengeEntryStanding_challengeId_fkey"
    FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ChallengeEntryComparison"
    ADD CONSTRAINT "ChallengeEntryComparison_challengeId_fkey"
    FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
