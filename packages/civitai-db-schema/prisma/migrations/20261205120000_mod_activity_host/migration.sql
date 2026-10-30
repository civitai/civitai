-- The site a moderator activity entry was recorded on. NULL for every existing row and for every
-- writer until one passes a host.
--
-- HAND-APPLIED. Apply BEFORE the release that ships the regenerated client: Prisma returns every
-- scalar from a ModActivity create, so a release ahead of the migration fails those writes.
--
-- Nullable, no default and no FK, so this is a catalog-only change with no rewrite or backfill.
-- It still needs a brief ACCESS EXCLUSIVE lock on "ModActivity": re-run on lock timeout.

SET lock_timeout = '3s';
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "host" TEXT;
