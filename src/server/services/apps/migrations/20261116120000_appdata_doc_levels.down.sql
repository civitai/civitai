-- Rollback of `20261116120000_appdata_doc_levels.sql`: drops the content-level columns of
-- `appdata.doc` (their constraints go with them) and every level and rating they hold. No
-- document body is touched. Turn `app-blocks-shared-doc-levels` off everywhere first: with it on,
-- a statement naming a dropped column fails. Same 1s lock_timeout as the up migration; if it
-- times out, re-run.
BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc
  DROP COLUMN IF EXISTS level,
  DROP COLUMN IF EXISTS rating_status,
  DROP COLUMN IF EXISTS override_level,
  DROP COLUMN IF EXISTS override_by,
  DROP COLUMN IF EXISTS override_at,
  DROP COLUMN IF EXISTS rated_at,
  DROP COLUMN IF EXISTS rated_version,
  DROP COLUMN IF EXISTS override_version;
COMMIT;
