-- Feed request capture — ClickHouse DDL.
--
-- Apply this MANUALLY (we do not auto-run DDL). Nothing writes to the table until capture is
-- switched on, so order relative to the app deploy does not matter here.
--
-- One row per image-feed search, sampled, from BOTH dispatch branches: the search-index path
-- (getImagesFromSearch, source = meili) and the Postgres path (getAllImages, source = db) that
-- requiresImageDbPath routes collections, posts, model-without-version and a few other shapes
-- to. The row carries the resolved search input — filters, sort, period, browsing level,
-- per-user exclusions — plus what the search returned and how long it took, so a window of
-- production traffic can be replayed against a candidate feed backend and compared request by
-- request.
--
-- A row identifies the viewer (userId, isModerator, browsingLevel) and the exact ids returned,
-- retained 30 days — the same as the tracker's views rows. The session user object itself is
-- never written; `input` is built from an allowlist of query-shape keys.
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
-- table does not need a tracker restart when it changes. Insert health is the
-- civitai_app_feed_request_capture_batches_total{outcome} counter.

CREATE TABLE IF NOT EXISTS default.feedRequests
(
  time DateTime64(3),
  traceId String,
  -- viewer; 0 = anonymous
  userId UInt32,
  isModerator UInt8,
  -- getImagesFromSearch | getAllImages
  source LowCardinality(String),
  -- headers.src of the caller (getInfiniteImagesHandler, home blocks, ...)
  callSite LowCardinality(String),
  -- feed-fetch-filter-in-post flag outcome on the meili path: pre | post; empty on the db path
  filterMode LowCardinality(String),
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
  -- allowlisted query-shape keys of the search input as JSON; exact replay source
  input String,
  error UInt8,
  elapsedMs UInt32,
  resultCount UInt16,
  resultIds Array(UInt32),
  nextCursor String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY time
TTL toDateTime(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Verify rows arrive after switching capture on:
--
--   SELECT source, count(), min(time), max(time) FROM feedRequests
--   WHERE time > now() - INTERVAL 10 MINUTE GROUP BY source;
--
-- Shape census (what share of traffic each filter dimension carries):
--
--   SELECT
--     countIf(source = 'db') / count() AS dbPath,
--     countIf(length(tags) > 0) / count() AS withTags,
--     countIf(modelVersionId > 0 OR modelId > 0) / count() AS modelGallery,
--     countIf(collectionId > 0) / count() AS collections,
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
