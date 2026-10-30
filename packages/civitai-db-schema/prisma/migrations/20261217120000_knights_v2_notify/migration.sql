-- Idempotent: applied by hand, possibly more than once, and safe on a database that already has the
-- first version of this table (column "type", no "confirmedAt").
-- Apply BEFORE deploying the Knights notification job: it claims a row here before it sends.
CREATE TABLE IF NOT EXISTS "KnightsNotificationSend" (
  "playerId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  CONSTRAINT "KnightsNotificationSend_pkey" PRIMARY KEY ("playerId", "day")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'KnightsNotificationSend' AND column_name = 'type'
  ) THEN
    ALTER TABLE "KnightsNotificationSend" RENAME COLUMN "type" TO "kind";
  END IF;
END $$;

ALTER TABLE "KnightsNotificationSend" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "KnightsNotificationSend_playerId_type_sentAt_idx";
CREATE INDEX IF NOT EXISTS "KnightsNotificationSend_playerId_kind_sentAt_idx"
  ON "KnightsNotificationSend" ("playerId", "kind", "sentAt");
