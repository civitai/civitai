-- Idempotent: applied by hand, possibly more than once.
-- Apply BEFORE deploying the Knights app: a Blocked rating vote writes the reason.
-- NULL for every older vote and every vote that is not a Blocked rating.
ALTER TABLE "KnightsVote" ADD COLUMN IF NOT EXISTS "blockReason" TEXT
  CHECK ("blockReason" IN ('InappropriateMinors', 'RealisticMinors', 'DepictsRealPerson', 'Bestiality', 'Other'));
