-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: votes and the status line read and write these columns.
-- ALTER on the partitioned "KnightsVote" parent propagates to every month.
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "xp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

ALTER TABLE "NewOrderPlayer" ADD COLUMN IF NOT EXISTS "goldPending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NewOrderPlayer" ADD COLUMN IF NOT EXISTS "goldEarned" INTEGER NOT NULL DEFAULT 0;

-- Graded votes whose progression is still to be granted: the sweep reads only these.
CREATE INDEX IF NOT EXISTS "KnightsVote_unsettled_idx" ON "KnightsVote" ("itemId")
  WHERE "settledAt" IS NULL AND "verdict" <> 'pending';
