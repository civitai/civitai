-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app build that serves hidden checks and issues smites.

-- A hidden check is an ordinary KnightsVote with a negative itemId (minus its reference image id); these record what
-- grading it cost the player and whether the player has dismissed the notice.
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "consequence" TEXT;
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "noticedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "KnightsVote_unnoticed_consequence_idx" ON "KnightsVote" ("playerId") WHERE "consequence" IS NOT NULL AND "noticedAt" IS NULL;

-- The NewOrderPlayer.startAt the player has been told about; a later one is a career reset they have not seen yet.
ALTER TABLE "KnightsPlayer" ADD COLUMN IF NOT EXISTS "startAtSeen" TIMESTAMP(3);
