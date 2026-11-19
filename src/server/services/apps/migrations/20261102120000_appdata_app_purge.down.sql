-- Rollback of `20261102120000_appdata_app_purge.sql`: drops the app-purge enumeration policy.
-- No data is touched. With it gone the deleted-app reaper refuses to run until it is re-applied.
BEGIN;
DROP POLICY IF EXISTS appdata_app_purge_read ON appdata.doc;
DROP POLICY IF EXISTS appdata_app_purge_read ON appdata.usage_app;
COMMIT;
