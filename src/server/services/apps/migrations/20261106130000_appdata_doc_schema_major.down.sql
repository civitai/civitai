-- Rollback of `20261106130000_appdata_doc_schema_major.sql`: drops `appdata.doc.schema_major` and
-- the stamps it holds. No document body is touched. Apply it only once no deployed code stamps the
-- column: a store that already found the column fails its next stamped write once after the drop,
-- then writes without the stamp. Same 1s lock_timeout as the up migration, for the same reason (a
-- waiting ALTER must give up before the store's own 3s lock timeout); if it times out, re-run.
BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc DROP COLUMN IF EXISTS schema_major;
COMMIT;
