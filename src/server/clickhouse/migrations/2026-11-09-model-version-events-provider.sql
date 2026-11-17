-- Per-provider download tokens — ClickHouse DDL.
--
-- Apply this MANUALLY, and read it back, BEFORE the app code that sends `provider` is deployed.
-- We do not auto-run DDL (same policy as the Postgres migrations).
--
-- One statement, two changes to `default.modelVersionEvents`:
--   1. `type` gains 'GenerationFetch' = 6. This is the same change as
--      2026-11-07-model-version-generation-fetch.sql, repeated here so this file can be applied
--      whether or not that one has been: re-declaring an identical Enum8 is a no-op. Appending at an
--      unused index is a metadata-only ALTER. Do NOT renumber or rename any existing value. Re-read
--      `SHOW CREATE TABLE default.modelVersionEvents` first: if a value other than
--      'GenerationFetch' already sits at 6, stop.
--   2. A `provider` column: the provider whose per-provider download token fetched the file. Empty
--      for every other row.
--
-- The app sends `provider` only on a per-provider download, so until a provider token is minted
-- no row carries it.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column
-- schema when its pods connect and never again, so until they restart it does not know the new
-- type value or the new column. See ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
--
-- Rollback: `ALTER TABLE default.modelVersionEvents DROP COLUMN provider`, only once nothing sends
-- it, then restart the tracker as in POST-APPLY so it stops expecting the column. The enum value stays (removing a value with rows is not a metadata-only change).

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.modelVersionEvents;
--     -- must show 'GenerationFetch' = 6, every value 1..5 unchanged, and
--     -- `provider` LowCardinality(String) DEFAULT ''.
--
-- Positive control once the tracker is restarted and a provider token is live: one download with
-- it, wait for the batch to flush, then (time bound first, as for every query on this table):
--
--   SELECT provider, count() FROM default.modelVersionEvents
--   WHERE time > now() - INTERVAL 1 HOUR AND type = 'GenerationFetch'
--   GROUP BY provider;
--     -- the provider must appear with a non-zero count.

-- No trailing semicolon and nothing after the statement: ClickHouse rejects the file as a
-- multi-statement query otherwise, so it can be run as-is.
--
ALTER TABLE default.modelVersionEvents
  MODIFY COLUMN `type` Enum8(
    'Create' = 1,
    'Publish' = 2,
    'Download' = 3,
    'Unpublish' = 4,
    'HideDownload' = 5,
    'GenerationFetch' = 6
  ),
  ADD COLUMN IF NOT EXISTS `provider` LowCardinality(String) DEFAULT ''
