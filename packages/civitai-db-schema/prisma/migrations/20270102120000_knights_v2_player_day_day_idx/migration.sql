-- Idempotent: applied by hand, possibly more than once.
-- The play rail sums today's votes across players; (day, votes) lets that read be an index-only scan.
CREATE INDEX IF NOT EXISTS "KnightsPlayerDay_day_votes_idx" ON "KnightsPlayerDay" ("day", "votes");
