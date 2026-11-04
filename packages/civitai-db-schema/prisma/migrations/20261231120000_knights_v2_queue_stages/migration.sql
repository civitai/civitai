-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app (the feed and the vote path read "escalatedAt").
-- The stage an item waits at is "minRank" (Knight, Templar, Paladin, then the Inquisitors); no second stage column is added.
-- "escalatedAt" is when the item last moved up a stage, null until a real escalation stamps it. The feed serves escalated
-- items first for a limited time after that.
ALTER TABLE "KnightsQueueItem" ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);

-- The feed's escalated window: open items per stage, oldest escalation first. Partial indexes are not expressible in
-- schema.full.prisma, so only the column is mirrored there.
CREATE INDEX IF NOT EXISTS "KnightsQueueItem_open_escalated_idx"
  ON "KnightsQueueItem" ("minRank", "escalatedAt")
  WHERE "status" = 'Open' AND "escalatedAt" IS NOT NULL;
