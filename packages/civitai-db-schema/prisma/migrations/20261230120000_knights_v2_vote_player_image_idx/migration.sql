-- Idempotent: applied by hand, possibly more than once. Apply BEFORE deploying the Knights app.
-- Serves "has this player judged this image" (hidden-check pick, one judgment per image and question) from one index range
-- instead of a scan of the player's votes. Created on the partitioned parent, like the earlier KnightsVote indexes, so
-- every existing and future month gets it. CREATE INDEX CONCURRENTLY is not allowed on a partitioned parent; this takes a
-- short write lock per partition while it builds.
CREATE INDEX IF NOT EXISTS "KnightsVote_playerId_imageId_idx" ON "KnightsVote" ("playerId", "imageId");
