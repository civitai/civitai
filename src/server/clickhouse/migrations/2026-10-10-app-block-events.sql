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
--      must list the 11 columns below, in order, with these types.
--   2. After the ingest deploy, send one DECLARED event from a real app block, then
--        SELECT count() FROM default.appBlockEvents
--        WHERE time > now() - INTERVAL 1 HOUR AND eventName != '__undeclared__'
--      must be non-zero. A zero without that positive send proves nothing.
--
-- One row per accepted `track()` call. Only manifest-declared events and properties are stored;
-- the ingest strips everything else before the insert:
--   - an undeclared event is stored as ONE row with eventName = '__undeclared__' and empty maps, so
--     the owner sees a drop count but the caller-chosen name is never stored. Declared names match
--     `^[a-z][a-z0-9_]{0,63}$` (BLOCK_ANALYTICS_NAME_RE), so no declared name can equal it;
--   - an undeclared property, or a value of the wrong type or outside an enum's declared values,
--     is dropped from its map.
-- There is no free-text column: every string stored is a platform id or a value an approved
-- manifest declared.
--
-- 🔴 THE RAW IP IS NOT STORED (unlike `blockRenders`). A signed-out viewer is identified only by
-- `viewerKey` = 'a:' + sha256(ip + a salt that rotates daily), so an anonymous viewer's key changes
-- every day: uniqExact(viewerKey) over a multi-day range counts one returning signed-out visitor
-- once per day they came back.
--
-- Retention: 400 days (the owner panel's longest range is 366). `ttl_only_drop_parts` drops a part
-- only once ALL its rows have expired, and parts merge within a monthly partition, so a row can
-- outlive 400 days by up to about a month plus the TTL merge lag (`merge_with_ttl_timeout`).
--
-- ORDER BY leads with (appBlockId, eventName) because every planned read is scoped to one app's ids,
-- and the per-event reads to one event as well.

CREATE TABLE IF NOT EXISTS default.appBlockEvents
(
  time DateTime64(3),
  appBlockId String,
  -- stamped by the host from its own props; the block never supplies identity
  blockInstanceId String,
  -- a declared event name, or '__undeclared__'
  eventName LowCardinality(String),
  -- viewer; 0 = signed out
  userId Int32,
  -- 'u:<userId>' signed in, 'a:<sha256 hex>' signed out (see the header); the unique-viewer key
  viewerKey String,
  isAnon UInt8,
  -- 1 when the viewer owns the app; the owner panel excludes these by default
  isOwner UInt8,
  -- declared enum properties: name -> one of its declared values
  enumProps Map(LowCardinality(String), LowCardinality(String)),
  numProps Map(LowCardinality(String), Float64),
  -- declared boolean properties: name -> 0 | 1
  boolProps Map(LowCardinality(String), UInt8)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (appBlockId, eventName, time)
TTL toDateTime(time) + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

-- The owner panel's reads, for reference (each also bounds `time`; add `AND isOwner = 0` unless the
-- owner has opted to include their own events):
--
-- Top events for one app:
--
--   SELECT eventName, count() AS events, uniqExact(viewerKey) AS viewers
--   FROM appBlockEvents
--   WHERE appBlockId = {appBlockId:String} AND eventName != '__undeclared__'
--     AND time >= {from:DateTime} AND time <= {to:DateTime} AND isOwner = 0
--   GROUP BY eventName ORDER BY events DESC LIMIT 50;
--
-- Daily series for one event (weekly past 60 days: toStartOfWeek(time, 1), which is Monday-based
-- to match Postgres `date_trunc('week', …)`):
--
--   SELECT toDate(time) AS day, count() AS events, uniqExact(viewerKey) AS viewers
--   FROM appBlockEvents
--   WHERE appBlockId = {appBlockId:String} AND eventName = {eventName:String}
--     AND time >= {from:DateTime} AND time <= {to:DateTime} AND isOwner = 0
--   GROUP BY day ORDER BY day;
--
-- Enum-property breakdown for one event:
--
--   SELECT kv.1 AS property, kv.2 AS value, count() AS events, uniqExact(viewerKey) AS viewers
--   FROM appBlockEvents ARRAY JOIN CAST(enumProps, 'Array(Tuple(String, String))') AS kv
--   WHERE appBlockId = {appBlockId:String} AND eventName = {eventName:String}
--     AND time >= {from:DateTime} AND time <= {to:DateTime} AND isOwner = 0
--   GROUP BY property, value ORDER BY property, events DESC;
