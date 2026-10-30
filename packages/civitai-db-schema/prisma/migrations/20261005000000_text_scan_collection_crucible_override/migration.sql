-- Moderator rating override + the level it was set against, for the two entities added to text-scan
-- in plan 08. Nullable, no default: catalog-only. One ALTER per table; re-run on lock timeout.
-- Apply BEFORE any build containing plan 08 runs against the database.
SET lock_timeout = '3s';
ALTER TABLE "Crucible"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER;
ALTER TABLE "Collection"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER;
RESET lock_timeout;
