-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: every vote writes the time the player spent on the item (after 20261229120000_knights_v2_answer_snapshot).
-- Measured on the server from the sealed feed token's issue time and clamped to 0..600000 ms; NULL for older votes, and for tokens without an issue time.
-- Added on the partitioned parent, so every monthly partition (existing and future) gets it.
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "msOnItem" INTEGER;
