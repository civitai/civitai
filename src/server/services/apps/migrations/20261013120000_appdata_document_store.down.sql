-- ROLLBACK for 20261013120000_appdata_document_store.sql. MANUAL-APPLY.
--
-- 🔴 DESTRUCTIVE: drops the `appdata` schema and every document, mark, counter
-- and usage row in it. Take a backup first if any app has written data. Apply by
-- hand to the same App Blocks datastore the forward migration was applied to.
--
-- ROLE SCOPE: `appdata_rw` is a CLUSTER-WIDE role, not a per-database object.
--   The store expects exactly one datastore database per Postgres server; if
--   the forward migration was ever applied to a second database on the same
--   server, the DROP ROLE below fails while that database still grants to it
--   (drop that database's schema first).
--
-- IDEMPOTENT: safe to re-run; a no-op once the schema and role are gone.

BEGIN;

DROP SCHEMA IF EXISTS appdata CASCADE;

DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appdata_rw') THEN
    -- Its only privileges were on the schema just dropped; memberships granted
    -- to the web app role go with the role.
    DROP ROLE appdata_rw;
  END IF;
END
$role$;

COMMIT;
