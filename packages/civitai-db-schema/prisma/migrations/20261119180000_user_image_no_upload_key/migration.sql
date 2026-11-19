\set ON_ERROR_STOP on
-- HAND-APPLIED with psql on a direct primary connection (not the transaction pooler). "User".image
-- never holds one of our upload keys: an uploaded avatar is the profile picture, and the profile save
-- refuses a key in image (civitai/civitai#9680 removed the last writer of one). This constraint makes
-- that hold for every writer.
--
-- The expression is `holdsUploadKeyText('image')` from @civitai/db-queries/profile-picture-clear
-- (any case, %2d read as a dash); user-image-key-check.behavior.test.ts fails if the two differ.
--
-- Apply only after: the web release and a moderator-v* tag carrying #9680 are live, and the one-off
-- clean-up of existing keys has run. NOT VALID skips the scan of existing rows; 20261119180100
-- validates them, and catches a key written between the guard and the ALTER.
--
-- ON_ERROR_STOP: the guard and the ALTER are separate transactions, so psql must stop at the guard's
-- error or the ALTER would still run. This file commits: dry-run it with the statements in the PR body,
-- never by wrapping the file in BEGIN ... ROLLBACK.

-- 1. The guard, a read on its own: no row may still hold a key (a NOT VALID constraint still fails
--    any later UPDATE of such a row). It scans "User"; the regex runs only on non-NULL image.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5min';
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE image IS NOT NULL
      AND replace(lower(image), '%2d', '-') ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  ) THEN
    RAISE EXCEPTION 'User.image still holds an upload key: run the clean-up first';
  END IF;
END
$guard$;
COMMIT;

-- 2. The constraint. ADD CONSTRAINT takes ACCESS EXCLUSIVE on "User" for a catalogue update, with no
--    scan. On a lock timeout nothing changes: retry off-peak rather than queue reads behind it.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "User" ADD CONSTRAINT "User_image_no_upload_key"
  CHECK (image IS NULL OR NOT (replace(lower(image), '%2d', '-') ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')) NOT VALID;
COMMIT;
