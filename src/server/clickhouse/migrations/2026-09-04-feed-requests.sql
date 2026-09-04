-- Feed request capture — ClickHouse DDL.
--
-- Apply this MANUALLY (we do not auto-run DDL). Nothing writes to the table until capture is
-- switched on, so order relative to the app deploy does not matter here.
--
-- One row per image-feed search (getImagesFromSearch), sampled. The row carries the resolved
-- search input — filters, sort, period, browsing level, per-user exclusions — plus what the
-- search returned and how long it took, so a window of production traffic can be replayed
-- against a candidate feed backend and compared request-by-request.
--
-- Switching capture on/off is a sysRedis hash, no deploy needed (the app re-reads it every 15s):
--
--   HSET system:feed-request-capture sampleRate 1 until 2026-09-08T14:00:00Z   -- 100% for a window
--   HSET system:feed-request-capture sampleRate 0.02                           -- 2% trickle, no end
--   HSET system:feed-request-capture sampleRate 0                              -- off
--
-- `until` is an ISO-8601 timestamp or epoch milliseconds; missing means no deadline.
--
-- Rows are inserted app-side directly (async_insert), not through the tracker service, so this
-- table does not need a tracker restart when it changes.

CREATE TABLE IF NOT EXISTS default.feedRequests
(
  time DateTime64(3),
  traceId String,
  -- viewer; 0 = anonymous
  userId UInt32,
  isModerator UInt8,
  sort LowCardinality(String),
  period LowCardinality(String),
  periodMode LowCardinality(String),
  browsingLevel UInt16,
  useCombinedNsfwLevel UInt8,
  limit UInt16,
  cursor String,
  tags Array(UInt32),
  excludedTagIds Array(UInt32),
  excludedUserIds Array(UInt32),
  modelId UInt32,
  modelVersionId UInt32,
  -- the `userId` search filter (feed-by-creator); named apart from the viewer column above
  filterUserId UInt32,
  postId UInt32,
  collectionId UInt32,
  hubId UInt32,
  types Array(LowCardinality(String)),
  baseModels Array(LowCardinality(String)),
  tools Array(UInt32),
  techniques Array(UInt32),
  -- names of the boolean input fields that were true (withMeta, followed, hidden, ...)
  flags Array(LowCardinality(String)),
  -- the full search input as JSON, minus session/transport fields; exact replay source
  input String,
  source LowCardinality(String),
  error UInt8,
  elapsedMs UInt32,
  resultCount UInt16,
  resultIds Array(UInt32),
  nextCursor String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY time
TTL toDateTime(time) + INTERVAL 30 DAY;

-- Verify rows arrive after switching capture on:
--
--   SELECT count(), min(time), max(time) FROM feedRequests WHERE time > now() - INTERVAL 10 MINUTE;
--
-- Shape census (what share of traffic each filter dimension carries):
--
--   SELECT
--     countIf(length(tags) > 0) / count() AS withTags,
--     countIf(modelVersionId > 0 OR modelId > 0) / count() AS modelGallery,
--     countIf(length(excludedTagIds) > 0) / count() AS withHiddenTags,
--     countIf(cursor != '') / count() AS deepPages,
--     quantile(0.99)(length(excludedTagIds)) AS p99HiddenTags
--   FROM feedRequests WHERE time > now() - INTERVAL 1 HOUR;
--
-- Export a window for replay (one JSON object per line):
--
--   SELECT * FROM feedRequests
--   WHERE time BETWEEN '2026-09-08 13:00:00' AND '2026-09-08 14:00:00'
--   ORDER BY time
--   FORMAT JSONEachRow
