-- Rollback of `20261118120000_appdata_doc_rating_id.sql` (roll back
-- `20261118120100_appdata_doc_rating_id_idx.sql` first): drops the rater's lookup policy, the
-- `doc.rating_id` column and its sequence. No document body, level or rating is touched; text-scan
-- verdict rows keyed on the dropped ids are left behind and the retry job deletes them. With the
-- policy gone the rater stops (`raterReady`). Same 1s lock_timeout; if it times out, re-run.
BEGIN;
SET LOCAL lock_timeout = '1s';
DROP POLICY IF EXISTS appdata_rater_lookup ON appdata.doc;
ALTER TABLE appdata.doc DROP COLUMN IF EXISTS rating_id;
DROP SEQUENCE IF EXISTS appdata.doc_rating_id_seq;
COMMIT;
