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
-- `viewerKey` is the unique-viewer key, computed in Node by the ingest as the first 8 bytes of a
-- sha256 digest read big-endian:
--   createHash('sha256').update(input).digest().readBigUInt64BE(0)
-- where input is 'u:' + userId for a signed-in viewer, and 'a:' + daySalt + ':' + ip for a
-- signed-out one. It can exceed 2^53, so send it as a decimal STRING in JSONEachRow. SQL computes
-- the same value with reinterpretAsUInt64(reverse(substring(SHA256(input), 1, 8))).
-- Normalise the ip before hashing so one address yields one key: an IPv4-mapped IPv6 address
-- becomes its IPv4 form, and IPv6 is written in lower-case canonical form.
--
-- 🔴 SALT CONTRACT — "THE RAW IP IS NOT STORED" HOLDS ONLY UNDER IT.
--   - `daySalt` is RANDOM, and ONE value shared by every ingest instance for the UTC day. A
--     per-process salt is not acceptable: N instances would give one signed-out viewer N keys a
--     day, and every restart would mint another.
--   - It lives in a shared store, created atomically (set-if-absent) with an expiry at the UTC day
--     boundary. The store must not keep it past that day in any form (no backup, snapshot or
--     write-log retention of the salt beyond its day).
--   - It is NEVER derived from a long-lived secret (no HMAC(secret, date)): IPv4 is only 2^32
--     addresses, so anyone holding a derivable salt can reverse every signed-out row for the full
--     400-day retention.
--
-- Because a signed-out key rotates daily, distinct keys grow with the length of the range (one
-- returning visitor counts once per day). The read path should use uniqCombined (approximate)
-- rather than uniqExact for week-bucketed ranges (over 60 days), where uniqExact's memory grows
-- with the distinct count.
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
  -- see the header for the derivation and the salt contract
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
