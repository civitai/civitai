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
-- `viewerKey` is the unique-viewer key, and ONLY signed-in viewers have one. For a signed-in
-- viewer it is the first 8 bytes of a sha256 digest read big-endian, computed in Node:
--   createHash('sha256').update('u:' + userId).digest().readBigUInt64BE(0)
-- It can exceed 2^53, so send it as a decimal STRING in JSONEachRow. SQL computes the same value
-- with reinterpretAsUInt64(reverse(substring(SHA256('u:' || toString(userId)), 1, 8))).
-- For a signed-out viewer it is 0, meaning "unknown viewer": nothing derived from a client
-- address is stored for signed-out viewers.
--
-- READ PATH: unique viewers are signed-in viewers only, counted as
--   uniqExactIf(viewerKey, viewerKey != 0)
-- Signed-out activity is reported as event counts (countIf(isAnon = 1)), never as unique viewers:
-- every signed-out row shares the key 0.
--
-- 🔴 AN ABSENT MAP KEY READS AS THE TYPE DEFAULT, not NULL: numProps['k'] = 0, boolProps['k'] = 0,
-- enumProps['k'] = ''. A property is optional per event, so every aggregate must gate on presence:
--   avgIf(numProps['k'], mapContains(numProps, 'k'))
--   countIf(mapContains(boolProps, 'k') AND boolProps['k'] = 1)   -- and = 0 for false
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
  -- see the header: a hash for signed-in viewers, 0 for signed-out
  viewerKey UInt64,
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
