-- HAND-APPLIED. "User".image never holds one of our upload keys: an uploaded avatar is the profile
-- picture, and the profile save refuses a key in image (see civitai/civitai#9680, which removed the last
-- writer of one). This constraint makes that hold for every writer.
--
-- The expression is `holdsUploadKeyText('image')` from @civitai/db-queries/profile-picture-clear
-- (any case, %2d read as a dash); user-image-key-check.behavior.test.ts fails if the two differ.
--
-- Apply only after: the web release and a moderator-v* tag carrying #9680 are live, the one-off
-- clean-up of existing keys has run, and the guard below finds no row. NOT VALID skips the scan of
-- existing rows here; 20261119180100 validates them. A row left over would still fail any later UPDATE
-- of that row, hence the guard.
--
-- ADD CONSTRAINT takes ACCESS EXCLUSIVE on "User" for a catalogue update, with no scan. lock_timeout
-- '3s' as for the other "User" migrations: on a timeout, retry off-peak rather than queue reads behind it.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE image IS NOT NULL
      AND replace(lower(image), '%2d', '-') ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  ) THEN
    RAISE EXCEPTION 'User.image still holds an upload key: run the clean-up first';
  END IF;
END
$$;

ALTER TABLE "User" ADD CONSTRAINT "User_image_no_upload_key"
  CHECK (image IS NULL OR NOT (replace(lower(image), '%2d', '-') ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')) NOT VALID;

COMMIT;
