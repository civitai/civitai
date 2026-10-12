-- App Blocks shared-storage `data` / counter-key moderation DENOMINATOR — ClickHouse DDL.
-- Apply MANUALLY (we do not auto-run DDL; same policy as the Postgres migrations).
--
-- 🔴 APPLY BEFORE relying on any rate read from `appBlocksSharedDataHits`, and before turning on
-- either flag `app-blocks-shared-data-moderation` or `app-blocks-shared-data-moderation-enforce`
-- if it is not on already. Both ship OFF, and with both off nothing writes here. Written by a
-- DIRECT insert from the app (src/server/services/apps/shared-data-moderation.ts,
-- `recordSharedDataScan`), not through civitai-clickhouse-tracker, so there is no tracker schema
-- cache to restart and no enum column for it to reject. ⚠️ The shared client inserts with
-- `wait_for_async_insert: 0`, so a server-side rejection is NOT guaranteed to reach the app: an
-- insert into a missing table may be dropped with no error logged. The write being moderated is
-- never affected either way.
--
-- POST-APPLY CHECK (the only proof rows land): with the shadow flag on for ONE app, write any
-- `data` blob to that app — a clean one is enough, since every scanned write records a row here,
-- hits or not — then
--   SELECT count() FROM default.appBlocksSharedDataScans WHERE time > now() - INTERVAL 1 HOUR
-- must be non-zero. A zero without that positive write proves nothing.
--
-- One row per SCANNED write — an append, an update, or a counter increment that the scan ran on —
-- in BOTH modes, hits or not. It is the denominator for any rate over `appBlocksSharedDataHits`
-- (join the two by day, not by `time`): writes scanned, leaves per write, writes rejected.
--
-- 🔴 NO USER TEXT IN ANY COLUMN, IN EITHER MODE: an id, the surface/mode/overflow kind (platform
-- values), and numbers. No row key, no path, no leaf, no matched term. The same fields also go to
-- the `app-blocks-shared-data-moderation-scan` log event; that event is a log line, not a durable
-- store, so it cannot carry a multi-week soak — this table is the denominator of record.
--
-- Retention: the same as `appBlocksSharedDataHits`, so numerator and denominator always cover the
-- same window. Rows expire 30 days after the start of the day they were written, and
-- `ttl_only_drop_parts` drops each daily partition whole once all of it has expired — at most 30
-- days plus the TTL merge scheduler's lag (`merge_with_ttl_timeout`, 4 h by default).

CREATE TABLE IF NOT EXISTS default.appBlocksSharedDataScans
(
  time DateTime64(3),
  appBlockId String,
  -- append | update | counter
  surface LowCardinality(String),
  -- shadow | enforce
  mode LowCardinality(String),
  -- 1 when this scan rejected the write (enforce mode only; always 0 in shadow)
  blocked UInt8,
  -- distinct leaves read in the `data` blob; 1 for a counter key; 0 when the blob overflowed a walk
  -- cap before any leaf was read
  leafCount UInt32,
  -- hit rows this write produced in `appBlocksSharedDataHits` (the sum of the six columns below)
  hitCount UInt32,
  -- hits per category in this write
  minor UInt32,
  poi UInt32,
  link UInt32,
  pattern UInt32,
  audit_regex UInt32,
  overflow UInt32,
  -- which cap overflowed: depth | leaves | chars | audit_budget | leaf_length, or '' for none
  overflowKind LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (time, appBlockId)
TTL toStartOfDay(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Blocked-write share per day — writes rejected over writes scanned (enforce mode; shadow rows
-- always carry blocked = 0):
--
--   SELECT toDate(time) AS day, mode, count() AS writes, sum(blocked) AS blocked,
--          round(blocked / writes, 4) AS blockedShare
--   FROM appBlocksSharedDataScans WHERE time > now() - INTERVAL 14 DAY
--   GROUP BY day, mode ORDER BY day, mode;
--
-- What enforce WOULD block, from a shadow soak — writes with at least one hit in a category that
-- rejects (a `pattern` hit rejects only while `user-content-pattern-enforce` is on; add it to the
-- sum when that flag is on):
--
--   SELECT toDate(time) AS day, count() AS writes,
--          countIf(minor + poi + overflow + link + audit_regex > 0) AS wouldBlock,
--          round(wouldBlock / writes, 4) AS wouldBlockShare
--   FROM appBlocksSharedDataScans WHERE mode = 'shadow' AND time > now() - INTERVAL 14 DAY
--   GROUP BY day ORDER BY day;
