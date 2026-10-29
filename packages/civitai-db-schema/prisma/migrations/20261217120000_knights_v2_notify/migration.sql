-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights notification job: it claims a row here before it sends.
CREATE TABLE IF NOT EXISTS "KnightsNotificationSend" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "type" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnightsNotificationSend_pkey" PRIMARY KEY ("playerId", "day")
);

CREATE INDEX IF NOT EXISTS "KnightsNotificationSend_playerId_type_sentAt_idx"
  ON "KnightsNotificationSend" ("playerId", "type", "sentAt");
