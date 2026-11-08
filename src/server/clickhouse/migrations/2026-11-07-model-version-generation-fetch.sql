-- Download links — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `GenerationFetch` is deployed. We do not
-- auto-run DDL (same policy as the Postgres migrations).
--
-- `modelVersionEvents.type` is an Enum8. A value the column does not carry is rejected at the
-- tracker service, silently: the row never exists. Only the new type is lost; the link still works.
--
-- This appends at 6, after 'HideDownload' (5).
-- Appending at an unused index is a metadata-only ALTER. Do NOT renumber or rename any existing
-- value. Re-read `SHOW CREATE TABLE default.modelVersionEvents` first: if prod already carries a
-- value at 6, renumber this one, not that.
--
-- The `mv_modelVersionEvents_to_kafka` view filters on type = 'Download', so it needs no change.
-- Re-check `system.tables` `dependencies_table` for any view added since.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column
-- schema when its pods connect and never again, so until they restart it still rejects the new
-- value. See ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.modelVersionEvents;
--     -- must show 'GenerationFetch' = 6, and every value 1..5 unchanged.
--
-- Positive control once the tracker is restarted and the app deployed: fetch one download link
-- for the first time, wait for the batch to flush, then:
--
--   SELECT countIf(type = 'GenerationFetch') AS fetches, countIf(type = 'Download') AS control
--   FROM default.modelVersionEvents WHERE time > now() - INTERVAL 1 HOUR;
--     -- fetches must be non-zero beside a non-zero control.

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
  )
