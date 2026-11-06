-- App Blocks document store: `(app_id, ns, seq)` indexes on `appdata.doc` and `appdata.doc_tomb`.
-- MANUAL-APPLY migration.
--
-- Not required for correctness; apply before the feed serves a large app. Safe before or after
--   the code ships. The feed (`SQL_FEED_DOCS_SINCE`, `SQL_FEED_TOMBS_SINCE` in `doc-store.ts`)
--   reads one app namespace's shared documents and tombstones by seq range. None of the existing
--   indexes leads with seq after (app_id, ns), so without these that read scans the namespace's
--   rows on every poll.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- SAFE BEFORE OR AFTER THE CODE SHIPS: the code is correct either way; only the read's cost
--   changes. CONCURRENTLY, so writes are not blocked while it builds; that also means it cannot
--   run inside a transaction block (no BEGIN/COMMIT here). If a build is interrupted it leaves an
--   INVALID index: drop it and re-run.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK:
--   DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_feed_seq_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS appdata.doc_tomb_feed_seq_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_feed_seq_idx ON appdata.doc (app_id, ns, seq);
CREATE INDEX CONCURRENTLY IF NOT EXISTS doc_tomb_feed_seq_idx ON appdata.doc_tomb (app_id, ns, seq);
