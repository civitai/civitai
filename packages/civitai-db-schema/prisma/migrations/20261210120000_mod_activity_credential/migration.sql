-- The credential a "heldMedia:view" row was fetched with: 'sheet' or 'web'. NULL for every existing
-- row and every other writer.
--
-- HAND-APPLIED. Apply BEFORE the release that ships the regenerated client: the moderator app names
-- this column in its insert, and Prisma returns every scalar from a ModActivity create, so a release
-- ahead of the migration fails those writes.
--
-- Nullable, no default and no FK, and the CHECK is NOT VALID, so nothing scans or rewrites the table.
-- It still needs a brief ACCESS EXCLUSIVE lock on "ModActivity": re-run on lock timeout.
--
-- To revert:
--   ALTER TABLE "ModActivity" DROP CONSTRAINT IF EXISTS "ModActivity_credential_check";
--   ALTER TABLE "ModActivity" DROP COLUMN IF EXISTS "credential";

BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "credential" TEXT;
ALTER TABLE "ModActivity" DROP CONSTRAINT IF EXISTS "ModActivity_credential_check";
ALTER TABLE "ModActivity" ADD CONSTRAINT "ModActivity_credential_check"
  CHECK ("credential" IN ('sheet', 'web')) NOT VALID;
COMMIT;
