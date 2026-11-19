-- Rollback of `20261119120000_appdata_doc_record_id.sql` (and of the unique index
-- `20261119120200_appdata_doc_record_id_unique.sql`): drops the index, then the `record_id`
-- column of `appdata.doc` and every id in it. No document body is touched. Every private record
-- URN built from these ids stops resolving, so roll back only before any is published.
--
-- The index drop is CONCURRENTLY, so it runs outside a transaction block; the column drop then
-- takes the same 1s lock_timeout as the up migration. If either times out, re-run.

DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_record_id_key;

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc DROP COLUMN IF EXISTS record_id;
COMMIT;
