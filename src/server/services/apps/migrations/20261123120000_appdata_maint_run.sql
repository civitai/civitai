-- App Blocks document store: MAINTENANCE RUNS, the record of the store's human-started data
-- migrations. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHAT IT ADDS (`docs/app-storage-generic-core.md`, "Data migration"): `appdata.maint_run`, one
--   row per run, keyed (app, namespace, collection, kind, name):
--   - kind `mark_migration`: one per (source collection, mark name) moved to a viewer-keyed
--     target by `migrateMarksToDocs`. `params` holds the target, the constant body and the key
--     mapping the run was started with; `status` is `frozen`, `copied`, `verified`, `mismatch`
--     or `rolled_back`; `result` holds the last copy's and verify's counts. While the row exists
--     and is not `rolled_back`, the store refuses `$mark` / `$unmark` of that mark on that
--     collection (`410 removed`): the row IS the freeze, read in the mark's own transaction.
--   - kind `purge`: the header of one per-collection purge (`name` is the run's ULID): `purging`
--     until no document is left, then `purged`, with its running totals in `result`.
--   - kind `purge_dump`: one per batch of a purge (`name` is `<run id>.<batch>`). `dump` holds
--     every row that batch deleted (documents, index rows, tallies and marks, report rows
--     included), written in the same transaction as the delete, so a purged document always has
--     its dump. Dumps are deleted 30 days after their purge finished, and an account deletion
--     removes the account from them.
--   `actor_uid` is the moderator who started the run.
--
-- ROW-LEVEL SECURITY on the new table: the policies every other `appdata` table has: the
--   (app, namespace) scope, and review maintenance's read and delete (a review namespace's row
--   is purged with its request; the store writes runs in the production namespace only). The
--   existing grants do not reach a table created after them, so it is granted here.
--
-- ROLLOUT ORDER: safe before or after the code ships. Until this is applied the store finds the
--   table missing (a savepoint probe, `withMaintRun` in `doc-store.ts`): marks are never frozen,
--   and every maintenance run refuses (`DocStoreMigrationPendingError`) before it writes
--   anything. Once applied, the store finds it within a minute, with no restart.
--
-- IDEMPOTENT: IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY, and a GRANT that
--   is already held is a no-op. ROLLBACK: the sibling `20261123120000_appdata_maint_run.down.sql`.

BEGIN;
SET LOCAL lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS appdata.maint_run (
  app_id     text COLLATE "C" NOT NULL,
  ns         text COLLATE "C" NOT NULL,
  coll       text COLLATE "C" NOT NULL,
  kind       text COLLATE "C" NOT NULL,
  name       text COLLATE "C" NOT NULL,
  status     text COLLATE "C" NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dump       jsonb,
  actor_uid  integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maint_run_scope_nonempty CHECK (app_id <> '' AND ns <> ''),
  CONSTRAINT maint_run_pkey PRIMARY KEY (app_id, ns, coll, kind, name),
  CONSTRAINT maint_run_kind CHECK (kind IN ('mark_migration', 'purge', 'purge_dump'))
);

ALTER TABLE appdata.maint_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE appdata.maint_run FORCE ROW LEVEL SECURITY;
-- As in the document-store migration: NULLIF folds an unset or ended setting to NULL, so the
-- predicate is NULL and the row invisible, the write refused.
DROP POLICY IF EXISTS appdata_scope ON appdata.maint_run;
CREATE POLICY appdata_scope ON appdata.maint_run
  USING (app_id = NULLIF(current_setting('appdata.app_id', true), '')
    AND ns = NULLIF(current_setting('appdata.ns', true), ''))
  WITH CHECK (app_id = NULLIF(current_setting('appdata.app_id', true), '')
    AND ns = NULLIF(current_setting('appdata.ns', true), ''));
DROP POLICY IF EXISTS appdata_review_read ON appdata.maint_run;
CREATE POLICY appdata_review_read ON appdata.maint_run FOR SELECT
  USING (current_setting('appdata.review_maintenance', true) = 'on'
    AND ns LIKE 'rev:%'
    AND app_id = NULLIF(current_setting('appdata.app_id', true), ''));
DROP POLICY IF EXISTS appdata_review_delete ON appdata.maint_run;
CREATE POLICY appdata_review_delete ON appdata.maint_run FOR DELETE
  USING (current_setting('appdata.review_maintenance', true) = 'on'
    AND ns LIKE 'rev:%'
    AND app_id = NULLIF(current_setting('appdata.app_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON appdata.maint_run TO appdata_rw;

COMMIT;
