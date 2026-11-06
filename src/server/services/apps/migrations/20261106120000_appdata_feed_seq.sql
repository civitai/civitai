-- App Blocks document store: partial `(app_id, ns, coll, seq) WHERE scope_uid = 0` indexes on
-- `appdata.doc` and `appdata.doc_tomb`, for the registry feed's seq-range reads.
-- MANUAL-APPLY migration.
--
-- Not required for correctness; apply before the feed serves a large app. Safe before or after
--   the code ships. The feed (`SQL_FEED_DOCS_SINCE`, `SQL_FEED_TOMBS_SINCE` in `doc-store.ts`)
--   reads one collection's SHARED documents and tombstones of one app namespace by seq range:
--   `app_id = $1 AND ns = $2 AND coll = $3 AND scope_uid = 0 AND seq > $4 AND seq <= $5 ORDER BY
--   seq`. Both tables carry `coll` and `scope_uid`. With `coll` in the key and `scope_uid = 0` as
--   the predicate, the range scan touches only that collection's shared rows: private writes and
--   other collections in the namespace are never walked. None of the existing indexes leads with
--   seq after (app_id, ns, coll), so without these that read scans the collection's rows on every
--   poll.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- CONCURRENTLY, so writes are not blocked while it builds; that also means it cannot run inside a
--   transaction block (no BEGIN/COMMIT here). If a build is interrupted it leaves an INVALID
--   index: drop it and re-run.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_feed_shared_seq_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_tomb_feed_shared_seq_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_feed_shared_seq_idx
  ON appdata.doc (app_id, ns, coll, seq) WHERE scope_uid = 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_tomb_feed_shared_seq_idx
  ON appdata.doc_tomb (app_id, ns, coll, seq) WHERE scope_uid = 0;
