-- A model's .com face: a separate title, description and cover for viewers
-- who see no mature content, plus a creator-picked .red cover. All NULL means today's behaviour.
--
-- HAND-APPLIED. Apply BEFORE the release that selects these columns: Prisma reads them on every
-- model page and feed query, so a release ahead of the migration 500s them.
--
-- Nullable, no default and no FK, so each ADD COLUMN is a catalog-only change. It still needs a
-- brief ACCESS EXCLUSIVE lock on "Model", a hot table: apply one statement at a time and re-run on
-- lock timeout.

SET lock_timeout = '3s';
ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS "sfwName" CITEXT;
ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS "sfwDescription" TEXT;
ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS "coverImageId" INTEGER;
ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS "sfwCoverImageId" INTEGER;
