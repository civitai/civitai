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
--   could not be derived when it was written. It is read only by a read path that migrates a body
--   on serve (a caller of `applyMajorChain`); any other read ignores it.
--
-- No default and no backfill, so the ALTER is a catalog change only (no table rewrite). It still
--   needs a brief ACCESS EXCLUSIVE lock on `appdata.doc`. While it WAITS for that lock (behind a
--   running store transaction), every store call that touches the table queues behind it, and the
--   store gives up on a lock after its own LOCK_TIMEOUT (3s, `doc-store.ts`) with `rate_limited`.
--   So the ALTER's `lock_timeout` is 1s, below the store's: a queued store call is delayed at most
--   about a second and is never refused because of this migration. If the ALTER times out, re-run
--   it. The existing table-wide grants to `appdata_rw` and the row-level policies cover the new
--   column.
--
-- SAFE BEFORE OR AFTER THE CODE SHIPS. Before: the code finds no column (a probe inside the
--   write's transaction, cached per process; re-checked every minute while absent) and writes
--   without it. After: the next probe finds it and writes start stamping.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK: the sibling `20261106130000_appdata_doc_schema_major.down.sql`
--   (drops the column and the stamps in it). Apply it only once no deployed code stamps the
--   column: a store that already found the column fails its next stamped write once after the
--   drop, then writes without the stamp.

BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE appdata.doc ADD COLUMN IF NOT EXISTS schema_major integer;
COMMIT;
