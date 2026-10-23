-- Creator Program pre-payout review: held payouts and the record of each review run.
--
-- Apply BEFORE the deploy that ships the review: settlement reads the review table on the 15th
-- and the review job writes both tables from the 1st.
--
-- HOW TO APPLY: `psql -v ON_ERROR_STOP=1 -f migration.sql`. Safe to run again.

CREATE TABLE IF NOT EXISTS "CreatorProgramPayoutReview" (
  "id"                SERIAL PRIMARY KEY,
  "period"            TEXT NOT NULL,
  "userId"            INTEGER NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'open',
  "hold"              BOOLEAN NOT NULL DEFAULT true,
  "signals"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "payoutCents"       INTEGER NOT NULL,
  "evidence"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "firstFlaggedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEvaluatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evaluations"       INTEGER NOT NULL DEFAULT 1,
  "decidedAt"         TIMESTAMP(3),
  "decidedBy"         TEXT,
  "decisionNote"      TEXT,
  "askRef"            TEXT,
  "version"           INTEGER NOT NULL DEFAULT 1,
  "decisions"         JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "CreatorProgramPayoutReview_status_check"
    CHECK ("status" IN ('open', 'escalated', 'cleared', 'withheld'))
);

-- Backfills columns added after an earlier version of this migration was applied.
ALTER TABLE "CreatorProgramPayoutReview"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "decisions" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorProgramPayoutReview_period_userId_key"
  ON "CreatorProgramPayoutReview" ("period", "userId");
CREATE INDEX IF NOT EXISTS "CreatorProgramPayoutReview_userId_idx"
  ON "CreatorProgramPayoutReview" ("userId");
CREATE INDEX IF NOT EXISTS "CreatorProgramPayoutReview_status_idx"
  ON "CreatorProgramPayoutReview" ("status");

CREATE TABLE IF NOT EXISTS "CreatorProgramPayoutReviewRun" (
  "id"             SERIAL PRIMARY KEY,
  "period"         TEXT NOT NULL,
  "startedAt"      TIMESTAMP(3) NOT NULL,
  "finishedAt"     TIMESTAMP(3),
  "creditedCount"  INTEGER NOT NULL DEFAULT 0,
  "evaluatedCount" INTEGER NOT NULL DEFAULT 0,
  "flaggedCount"   INTEGER NOT NULL DEFAULT 0,
  "error"          TEXT
);

CREATE INDEX IF NOT EXISTS "CreatorProgramPayoutReviewRun_period_startedAt_idx"
  ON "CreatorProgramPayoutReviewRun" ("period", "startedAt");
