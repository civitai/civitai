-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app. The weekly board groups votes cast in the window by player (this index; `verdict` is carried so the scan skips the table). One player's status line uses the existing ("playerId","createdAt") index. Created on the partitioned parent, so every month gets it.
-- Partial indexes are not expressible in schema.full.prisma, so there is no schema change.
DROP INDEX IF EXISTS "KnightsVote_playerId_settledAt_idx";
CREATE INDEX IF NOT EXISTS "KnightsVote_createdAt_playerId_idx" ON "KnightsVote" ("createdAt", "playerId")
  INCLUDE ("verdict") WHERE "settledAt" IS NOT NULL;
