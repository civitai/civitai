-- App Blocks document store: an index on `appdata.usage_user (user_id)`. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore, the same one
--   `20261013120000_appdata_document_store.sql` was applied to (NOT the main civitai
--   database). Apply it by hand (psql) as the role that owns the `appdata` tables, once per
--   environment. Nothing applies this automatically.
--
-- WHY: the account-settings "App storage" list reads one user's usage rows across apps
--   (`SQL_VIEWER_PROD_USAGE` in `doc-store.ts`), keyed on `user_id`. The table's primary key is
--   (app_id, ns, user_id), so without this index that read scans the whole table on every
--   settings page view. The account-wipe enumeration reads the same rows and benefits too.
--
-- SAFE BEFORE OR AFTER THE CODE SHIPS: the code is correct either way; only the read's cost
--   changes. CONCURRENTLY, so writes are not blocked while it builds; that also means it cannot
--   run inside a transaction block (no BEGIN/COMMIT here). If a build is interrupted it leaves an
--   INVALID index: drop it and re-run.
--
-- IDEMPOTENT: IF NOT EXISTS. ROLLBACK: `DROP INDEX CONCURRENTLY IF EXISTS appdata.usage_user_user_idx;`

CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_user_user_idx ON appdata.usage_user (user_id);
