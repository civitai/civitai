-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: an Acolyte's level-up writes this table.
CREATE TABLE IF NOT EXISTS "KnightsAcolyteLevelGold" (
  "playerId" INTEGER NOT NULL,
  "level" INTEGER NOT NULL,
  "gold" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsAcolyteLevelGold_pkey" PRIMARY KEY ("playerId", "level")
);
