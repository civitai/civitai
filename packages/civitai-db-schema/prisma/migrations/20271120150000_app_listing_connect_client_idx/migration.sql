-- Index for the auth hub's offline-access read (apps/auth listing-offline.ts), which runs on an
-- authorize request asking for offline_access, at its code exchange, and on a refresh under an
-- offline grant, while the `oauth-offline-grant` flag is on:
--   SELECT id, status, connect_scope_justifications FROM app_listings
--   WHERE connect_client_id = $1 AND kind = 'offsite'
-- Without it that read is a sequential scan of app_listings. Partial: only connect listings carry a
-- client (on-site and external-link listings leave connect_client_id NULL), so the index holds
-- just those rows.
--
-- MANUAL APPLY, per environment. CONCURRENTLY cannot run inside a transaction, so run this ONE
-- statement on its own, outside BEGIN/COMMIT (the BEGIN; ... ROLLBACK; dry run does not apply to
-- it). IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying,
-- check pg_index.indisvalid, and if false run
-- `DROP INDEX CONCURRENTLY IF EXISTS app_listings_connect_client_id_idx` and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS app_listings_connect_client_id_idx
  ON app_listings (connect_client_id)
  WHERE connect_client_id IS NOT NULL;
