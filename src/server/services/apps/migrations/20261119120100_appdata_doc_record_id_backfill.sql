-- App Blocks document store: BACKFILL of `appdata.doc.record_id` for rows written before
-- `20261119120000_appdata_doc_record_id.sql` gave the column its default. A data script, not a
-- schema migration. MANUAL-APPLY.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Run it by hand (psql) once per environment, AFTER the column migration. Nothing
--   runs this automatically.
--
-- ROLE: `appdata.doc` has FORCE ROW LEVEL SECURITY, which binds the table owner too: run as the
--   owner, this sees no rows and updates nothing. Run it as a superuser or a BYPASSRLS role.
--
-- BATCHES: walks the table in primary-key order, 1000 rows per batch, giving each row whose
--   `record_id` is still NULL a fresh `gen_random_uuid()`, and COMMITs after every batch, so no
--   lock is held for longer than one batch. It sleeps 50ms between batches. The COMMIT inside a
--   DO block needs Postgres 11+ and a DO run OUTSIDE a transaction block: run it with plain
--   `psql -f`, never `psql -1` / `--single-transaction` and never after a BEGIN.
--
--   The key columns are COLLATE "C" (bytewise), so the cursor variables are too: the row
--   comparison then walks the primary-key index in its own order.
--
-- IDEMPOTENT AND RESUMABLE: only NULL ids are written, so an interrupted run (a lock timeout, a
--   deadlock, a cancel) is simply run again; it re-walks the keys and fills what is left. Rows
--   inserted while it runs already have an id from the column default. Expected to end with:
--   SELECT count(*) FROM appdata.doc WHERE record_id IS NULL;  -- 0

SET lock_timeout = '1s';

DO $backfill$
DECLARE
  k_app   text COLLATE "C" := '';
  k_ns    text COLLATE "C" := '';
  k_coll  text COLLATE "C" := '';
  k_scope integer := -1;
  k_key   text COLLATE "C" := '';
  filled  bigint := 0;
  n       integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT d.app_id, d.ns, d.coll, d.scope_uid, d.key
      FROM appdata.doc d
      WHERE (d.app_id, d.ns, d.coll, d.scope_uid, d.key) > (k_app, k_ns, k_coll, k_scope, k_key)
      ORDER BY d.app_id, d.ns, d.coll, d.scope_uid, d.key
      LIMIT 1000
    ), filled_rows AS (
      UPDATE appdata.doc d
      SET record_id = gen_random_uuid()
      FROM batch b
      WHERE d.app_id = b.app_id AND d.ns = b.ns AND d.coll = b.coll
        AND d.scope_uid = b.scope_uid AND d.key = b.key
        AND d.record_id IS NULL
      RETURNING 1
    )
    SELECT b.app_id, b.ns, b.coll, b.scope_uid, b.key, (SELECT count(*) FROM filled_rows)
      INTO k_app, k_ns, k_coll, k_scope, k_key, n
    FROM batch b
    ORDER BY b.app_id DESC, b.ns DESC, b.coll DESC, b.scope_uid DESC, b.key DESC
    LIMIT 1;
    EXIT WHEN NOT FOUND;
    filled := filled + n;
    COMMIT;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE 'appdata.doc record_id backfill: % rows filled', filled;
END
$backfill$;

RESET lock_timeout;
