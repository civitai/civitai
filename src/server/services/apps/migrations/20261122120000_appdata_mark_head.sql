-- App Blocks document store: the MARK SEQUENCE, one counter per (app, namespace). MANUAL-APPLY
-- migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS (`apps/app-data-go/WRITES-DESIGN.md`, "Marks get their own sequence"):
--   - `appdata.mark_head`: one row per app namespace. `last_mark_seq` is the namespace's newest
--     mark sequence: `mark`, `unmark` and `increment` each take the next one (`SQL_TAKE_MARK_SEQ`
--     in `doc-store.ts`), shared by every collection of the app, as `usage_app.last_seq` is for
--     document writes. Its row is the store's lock (1c): taken after the document and its tally
--     and mark rows, before `usage_app`, and never by a document write.
--   - `mark_seq` on `appdata.doc_tally`: the mark sequence of the last mark, unmark or increment
--     that changed the tally row. Nullable, no default and no backfill: NULL is a row last changed
--     before this existed. Nothing reads it yet. (`doc_mark` gets no column: what a per-viewer
--     reader needs from the viewer's own mark rows is the per-viewer stream's design to decide.)
--   `doc.seq`, which moderation and the rater check as a document's revision, is not touched.
--
-- ROW-LEVEL SECURITY on the new table: the policies every other `appdata` table has: the
--   (app, namespace) scope, and review maintenance's read and delete (a review namespace's row
--   is purged with its request). The existing grants do not reach a table created after them,
--   so it is granted here.
--
-- ROLLOUT ORDER: safe before or after the code ships. Until this is applied the store finds
--   the table missing (a savepoint probe, `withMarkHead` in `doc-store.ts`), takes no sequence
--   and answers marks, unmarks and increments without one; once applied, it starts taking the
--   sequence within a minute, with no restart. Apply it to each environment, dev then prod.
--
-- Lock discipline as `20261116120000_appdata_doc_levels.sql`: the ALTER is catalog-only
--   (nullable, no default), a brief ACCESS EXCLUSIVE lock, under a 1s lock_timeout below the
--   store's own 3s. If it times out, re-run the file.
--
-- IDEMPOTENT: IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY, and a GRANT that
--   is already held is a no-op. ROLLBACK: the sibling `20261122120000_appdata_mark_head.down.sql`.

BEGIN;
SET LOCAL lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS appdata.mark_head (
  app_id        text COLLATE "C" NOT NULL,
  ns            text COLLATE "C" NOT NULL,
  last_mark_seq bigint NOT NULL DEFAULT 0,
  CONSTRAINT mark_head_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT mark_head_pkey PRIMARY KEY (app_id, ns)
);

ALTER TABLE appdata.doc_tally ADD COLUMN IF NOT EXISTS mark_seq bigint;

ALTER TABLE appdata.mark_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE appdata.mark_head FORCE ROW LEVEL SECURITY;
-- As in the document-store migration: NULLIF folds an unset or ended setting to NULL, so the
-- predicate is NULL and the row invisible, the write refused.
DROP POLICY IF EXISTS appdata_scope ON appdata.mark_head;
CREATE POLICY appdata_scope ON appdata.mark_head
  USING (app_id = NULLIF(current_setting('appdata.app_id', true), '')
    AND ns = NULLIF(current_setting('appdata.ns', true), ''))
  WITH CHECK (app_id = NULLIF(current_setting('appdata.app_id', true), '')
    AND ns = NULLIF(current_setting('appdata.ns', true), ''));
DROP POLICY IF EXISTS appdata_review_read ON appdata.mark_head;
CREATE POLICY appdata_review_read ON appdata.mark_head FOR SELECT
  USING (current_setting('appdata.review_maintenance', true) = 'on'
    AND ns LIKE 'rev:%'
    AND app_id = NULLIF(current_setting('appdata.app_id', true), ''));
DROP POLICY IF EXISTS appdata_review_delete ON appdata.mark_head;
CREATE POLICY appdata_review_delete ON appdata.mark_head FOR DELETE
  USING (current_setting('appdata.review_maintenance', true) = 'on'
    AND ns LIKE 'rev:%'
    AND app_id = NULLIF(current_setting('appdata.app_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON appdata.mark_head TO appdata_rw;

COMMIT;
