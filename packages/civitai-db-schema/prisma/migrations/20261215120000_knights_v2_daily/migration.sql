-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: every vote reads and writes these tables.
CREATE TABLE IF NOT EXISTS "KnightsPlayer" (
  "playerId" INTEGER NOT NULL,
  "streak" INTEGER NOT NULL DEFAULT 0,
  "lastWatchDay" DATE,
  "shields" INTEGER NOT NULL DEFAULT 0,
  "shieldWeek" DATE NOT NULL,
  "recapDismissedFor" DATE,
  CONSTRAINT "KnightsPlayer_pkey" PRIMARY KEY ("playerId")
);

CREATE TABLE IF NOT EXISTS "KnightsPlayerDay" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "votes" INTEGER NOT NULL DEFAULT 0,
  "goldRecorded" INTEGER NOT NULL DEFAULT 0,
  "watchCompletedAt" TIMESTAMP(3),
  "bonusGold" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "KnightsPlayerDay_pkey" PRIMARY KEY ("playerId", "day")
);
