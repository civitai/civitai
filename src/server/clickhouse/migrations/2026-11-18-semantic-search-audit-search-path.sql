-- `semanticSearchAudit.searchPath` — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply by hand BEFORE the release that writes it. Every row carries the key, so an
-- app live before the column exists fails whole batches (see 2026-11-08-user-activities-source.sql).
--
-- Values: served | narrowed | refused_query | refused_correction | refused_own_images |
-- refused_upload_level.
-- Empty on rows written before this column.
--
-- Verify, AFTER applying:
--
--   SELECT name, type, default_expression FROM system.columns
--   WHERE database = 'default' AND table = 'semanticSearchAudit' AND name = 'searchPath';
--     -- one row: LowCardinality(String), default ''.
--
-- Positive control once the release is live:
--
--   SELECT searchPath, count() FROM default.semanticSearchAudit
--   WHERE time > now() - INTERVAL 1 HOUR GROUP BY searchPath;
--     -- 'served' must be non-zero. Only '' means the release is not live yet.
--
-- Rollback: roll the release back first, then
-- `ALTER TABLE default.semanticSearchAudit DROP COLUMN searchPath`.

-- No trailing semicolon and nothing after the statement: ClickHouse rejects the file as a
-- multi-statement query otherwise, so it can be run as-is.
ALTER TABLE default.semanticSearchAudit
  ADD COLUMN IF NOT EXISTS `searchPath` LowCardinality(String) DEFAULT ''