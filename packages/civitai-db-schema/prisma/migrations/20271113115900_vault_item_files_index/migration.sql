-- Index on VaultItem.files for containment (@>) lookups by file id, used by the trigger in
-- 20271113120000_vault_file_scan_snapshot. Apply BEFORE that migration.
-- CONCURRENTLY: run it on its own, outside a transaction (so no BEGIN/ROLLBACK dry run).
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid, and if false, DROP INDEX CONCURRENTLY and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "VaultItem_files_idx"
  ON "VaultItem" USING gin ("files" jsonb_path_ops);
