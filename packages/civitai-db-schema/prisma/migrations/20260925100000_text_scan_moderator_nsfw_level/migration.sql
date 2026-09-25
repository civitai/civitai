-- Moderator rating override + the content-derived level it was set against, on four
-- text-scanned entities (Article's shape), and the Buzz type a bounty was paid in.
-- Nullable with no default: catalog-only, no table rewrite. One ALTER per table, so a
-- lock timeout leaves a table either fully migrated or untouched; re-run the file.
-- Apply BEFORE any build of feat/text-scan deploys: every Post/Bounty/BountyEntry recompute selects these.
SET lock_timeout = '3s';
ALTER TABLE "Post"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER;
ALTER TABLE "Bounty"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER,
  ADD COLUMN IF NOT EXISTS "buzzType" TEXT;
ALTER TABLE "BountyEntry"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER;
ALTER TABLE "Challenge"
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevel" INTEGER,
  ADD COLUMN IF NOT EXISTS "moderatorNsfwLevelBasis" INTEGER;
RESET lock_timeout;
