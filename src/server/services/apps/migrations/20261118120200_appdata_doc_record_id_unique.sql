-- App Blocks document store: a unique index on `appdata.doc.record_id`. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS: uniqueness of `record_id` (`20261118120000_appdata_doc_record_id.sql`), the id
--   in a private record's URN, so one id can never name two documents. NULLs (rows the backfill
--   has not reached) do not conflict. Apply after the backfill
--   (`20261118120100_appdata_doc_record_id_backfill.sql`); it is also correct before it.
--
-- CONCURRENTLY, so writes are not blocked while it builds; that also means it cannot run inside a
--   transaction block (no BEGIN/COMMIT here), which is why it is a file of its own. If a build is
--   interrupted it leaves an INVALID index: drop it
--   (`DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_record_id_key;`) and re-run.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_record_id_key;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS doc_record_id_key
  ON appdata.doc (record_id);
