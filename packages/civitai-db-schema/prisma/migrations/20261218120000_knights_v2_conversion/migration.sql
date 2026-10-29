-- Idempotent: applied by hand, possibly more than once.
-- Apply after 20261213120000_knights_v2_progression and BEFORE deploying the Knights app and the main app (the generated
-- Prisma client reads the NewOrderPlayer gold columns): the detection job writes KnightsDetectionRun and
-- the Knights tick reads the new columns and tables.
-- ALTER on the partitioned "KnightsVote" parent (indexes) propagates to every month.

ALTER TABLE "NewOrderPlayer" ADD COLUMN IF NOT EXISTS "goldCleared" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NewOrderPlayer" ADD COLUMN IF NOT EXISTS "goldConverted" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "KnightsDetectionRun" (
  "id" SERIAL PRIMARY KEY,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "passedAt" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "KnightsGoldClearing" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "runId" INTEGER NOT NULL,
  "gold" INTEGER NOT NULL,
  "clearedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsGoldClearing_playerId_runId_key" ON "KnightsGoldClearing" ("playerId", "runId");

CREATE TABLE IF NOT EXISTS "KnightsGoldConversion" (
  "id" SERIAL PRIMARY KEY,
  "playerId" INTEGER NOT NULL,
  "gold" INTEGER NOT NULL,
  "buzz" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "externalTransactionId" TEXT NOT NULL,
  "buzzTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3)
);
ALTER TABLE "KnightsGoldConversion" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "KnightsGoldConversion_externalTransactionId_key" ON "KnightsGoldConversion" ("externalTransactionId");
CREATE INDEX IF NOT EXISTS "KnightsGoldConversion_playerId_createdAt_idx" ON "KnightsGoldConversion" ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS "KnightsGoldConversion_status_createdAt_idx" ON "KnightsGoldConversion" ("status", "createdAt");

CREATE INDEX IF NOT EXISTS "KnightsDetectionRun_unpassed_idx" ON "KnightsDetectionRun" ("id") WHERE "passedAt" IS NULL;

-- Players with earned gold not yet cleared.
CREATE INDEX IF NOT EXISTS "NewOrderPlayer_uncleared_gold_idx" ON "NewOrderPlayer" ("userId")
  WHERE "goldEarned" > "goldCleared";

CREATE INDEX IF NOT EXISTS "KnightsVote_unlabelled_idx" ON "KnightsVote" ("settledAt")
  WHERE "settledAt" IS NOT NULL AND NOT "labelled";

CREATE INDEX IF NOT EXISTS "KnightsVote_player_settled_gold_idx" ON "KnightsVote" ("playerId", "settledAt")
  WHERE "gold" > 0;
