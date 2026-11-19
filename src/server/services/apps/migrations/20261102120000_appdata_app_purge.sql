-- App Blocks document store — app-purge enumeration policy. MANUAL-APPLY migration.
--
-- TARGET DATABASE: the App Blocks datastore that holds the `appdata` schema (the same database
--   as `20261013120000_appdata_document_store.sql`, which must already be applied), NOT the main
--   civitai database. Apply it by hand (psql) as the role that applied that migration, once per
--   environment that has the datastore. Nothing applies it automatically.
--
-- WHAT IT ADDS: one read-only policy, `appdata_app_purge_read`, on `doc` and `usage_app`. A
--   transaction that sets `appdata.app_purge_id` to an app id may READ that ONE app's rows of
--   those two tables, in every namespace. That is how the deleted-app reaper finds the namespaces
--   an app has data in. Nothing else: no other table, no other app, no insert, update or delete.
--   The delete itself runs one ordinary (app, namespace)-scoped transaction per batch. Only the
--   app-purge enumeration in `doc-store.ts` (`appPurgeTx`) sets the setting.
--
-- UNTIL IT IS APPLIED the purge refuses to run (`listAppNamespaces` checks `pg_policies` for this
--   policy on both tables), so no app is reported purged while its rows are still there.
--
-- IDEMPOTENT: DROP IF EXISTS + CREATE inside one transaction; safe to re-run. ROLLBACK: the
--   sibling `20261102120000_appdata_app_purge.down.sql` (drops the policy; no data is touched).

BEGIN;

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc', 'usage_app']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS appdata_app_purge_read ON appdata.%I', t);
    -- NULLIF folds an unset or ended setting ('' on a reused connection) to NULL, so the
    -- predicate is NULL and admits nothing, as in the document-store migration.
    EXECUTE format(
      'CREATE POLICY appdata_app_purge_read ON appdata.%I FOR SELECT '
      'USING (app_id = NULLIF(current_setting(''appdata.app_purge_id'', true), ''''))',
      t);
  END LOOP;
END
$rls$;

COMMIT;
