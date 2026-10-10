-- App Blocks custom events (`useBlockAnalytics().track()`) — ClickHouse DDL.
-- Apply MANUALLY (we do not auto-run DDL; same policy as the Postgres migrations).
--
-- 🔴 APPLY BEFORE the ingest endpoint (`POST /api/track/block-event`) deploys, in every environment
-- it deploys to. Rows are written by a DIRECT insert from the app, not through
-- civitai-clickhouse-tracker, so there is no tracker schema cache to restart and no enum column for
-- it to reject. ⚠️ The shared client inserts with `async_insert: 1, wait_for_async_insert: 0`, so an
-- insert into a missing table is not guaranteed to surface as an error in the app: events can be
-- dropped with nothing logged.
--
-- POST-APPLY CHECK, in two halves:
--   1. Before the ingest deploy, prove the table exists with the expected shape:
--        SELECT name, type FROM system.columns
--        WHERE database = 'default' AND table = 'appBlockEvents' ORDER BY position;
--      must match the columns below, in order and type.
--   2. After the ingest deploy, send one DECLARED event from a real app block, then
--        SELECT count() FROM default.appBlockEvents
--        WHERE time > now() - INTERVAL 1 HOUR AND eventName != '__undeclared__'
--      must be non-zero. A zero without that positive send proves nothing.
--
-- One row per accepted `track()` call. Only manifest-declared events and properties are stored;
-- the ingest strips everything else before the insert:
--   - an undeclared event is stored as ONE row with eventName = '__undeclared__' and empty maps, so
--     the owner sees a drop count but the caller-chosen name is never stored. `BLOCK_ANALYTICS_NAME_RE`
--     cannot match it (no leading underscore), so no declared name collides;
--   - an undeclared property, or a value of the wrong type or outside an enum's declared values,
--     is dropped from its map.
-- There is no free-text column: every string stored is a platform id or a value an approved
-- manifest declared.
--
-- 🔴 THE RAW IP IS NOT STORED. A signed-out viewer's `viewerKey` is a hash of the IP with a
-- server-secret salt that rotates daily (a guessable salt would let the hash be reversed by brute
-- force), so uniqExact(viewerKey) across days counts a returning signed-out visitor once per day.
--
-- Retention: 400 days, which must stay above `MAX_RANGE_DAYS` in
-- src/server/services/blocks/app-analytics.service.ts.
-- `ttl_only_drop_parts` drops a part only once ALL its rows have expired, and parts merge within a
-- monthly partition, so a row can outlive 400 days by up to about a month plus the TTL merge lag
-- (`merge_with_ttl_timeout`).

CREATE TABLE IF NOT EXISTS default.appBlockEvents
(
  time DateTime64(3),
  appBlockId String,
  blockInstanceId String,
  eventName LowCardinality(String),
  -- viewer; 0 = signed out
  userId Int32,
  -- 'u:<userId>' | 'a:<daily-salted ip sha256 hex>'
  viewerKey String,
  isAnon UInt8,
  isOwner UInt8,
  enumProps Map(LowCardinality(String), LowCardinality(String)),
  numProps Map(LowCardinality(String), Float64),
  -- 0 | 1
  boolProps Map(LowCardinality(String), UInt8)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (appBlockId, eventName, time)
TTL toDateTime(time) + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;
