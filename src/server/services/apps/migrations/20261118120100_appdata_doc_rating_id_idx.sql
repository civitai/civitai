-- App Blocks document store: the index the rater's lookup by rating id reads
-- (`SQL_RATER_LOOKUP` in `doc-store.ts`). MANUAL-APPLY migration, right after
-- `20261118120000_appdata_doc_rating_id.sql`.
--
-- TARGET DATABASE: the App Blocks datastore (NOT the main civitai database), as that migration.
--
-- UNIQUE and partial: only rated documents carry an id, and an id names one document. Without it
--   each scan callback's lookup scans `doc`. Safe before or after the code ships.
--
-- CONCURRENTLY, so writes are not blocked while it builds; that also means it cannot run inside a
--   transaction block (no BEGIN/COMMIT here). If a build is interrupted it leaves an INVALID
--   index: drop it and re-run.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK: `20261118120100_appdata_doc_rating_id_idx.down.sql`.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS doc_rating_id_key
  ON appdata.doc (rating_id) WHERE rating_id IS NOT NULL;
