-- App Blocks document store: a nullable `schema_major` column on `appdata.doc`. MANUAL-APPLY
-- migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS: `schema_major`, the major of the collection's schema a document's body was
--   written under (`services/apps/storage-schema-majors.ts`). The store stamps it on every write
--   of a production document's body (create, put, the first increment that creates a counter
--   document, and a schema migration's rewrite). NULL means "not known": a document written
--   before this column existed, one in a development or review namespace, or one whose major
--   could not be derived when it was written. Nothing reads the column yet.
--
-- No default and no backfill, so the ALTER is a catalog change only (no table rewrite). It still
--   takes a brief ACCESS EXCLUSIVE lock on `appdata.doc`, so it waits at most `lock_timeout` behind
--   a running transaction instead of queueing every store call behind it; if it times out, re-run.
--   The existing table-wide grants to `appdata_rw` and the row-level policies cover the new column.
--
-- SAFE BEFORE OR AFTER THE CODE SHIPS. Before: the code finds no column (a probe inside the
--   write's transaction, cached per process; re-checked every minute while absent) and writes
--   without it. After: the next probe finds it and writes start stamping.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK (only once no deployed code stamps the column; a write by
--   code that already found it fails once per process after the drop, then stops stamping):
--   ALTER TABLE appdata.doc DROP COLUMN IF EXISTS schema_major;

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE appdata.doc ADD COLUMN IF NOT EXISTS schema_major integer;
COMMIT;
