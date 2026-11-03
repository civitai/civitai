-- Idempotent: applied by hand, possibly more than once. Applied once on dev with an earlier index; this replaces it.
-- Apply BEFORE deploying the Knights app. Fervor is read from votes cast in the last days: the weekly board groups
-- them by player (this index, `verdict` carried so the scan need not visit the table), and one player's status line
-- uses the existing ("playerId","createdAt") index. Created on the partitioned parent, so every month gets it.
-- Partial indexes are not expressible in schema.full.prisma, so there is no schema change.
DROP INDEX IF EXISTS "KnightsVote_playerId_settledAt_idx";
CREATE INDEX IF NOT EXISTS "KnightsVote_createdAt_playerId_idx" ON "KnightsVote" ("createdAt", "playerId")
  INCLUDE ("verdict") WHERE "settledAt" IS NOT NULL;
