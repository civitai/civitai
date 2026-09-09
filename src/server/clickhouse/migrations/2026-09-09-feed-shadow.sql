-- Feed shadow comparison — ClickHouse DDL. Apply MANUALLY (we do not auto-run DDL).
--
-- One row per image-feed search mirrored to the candidate feed service (civitai-feed):
-- the mapped query, both answers, both latencies, and how much they agree. Rows whose
-- search shape the mapper cannot express carry a skipReason instead of an answer, so the
-- table also measures request coverage. The viewer's response is never affected.
--
--   HSET system:feed-shadow sampleRate 0.01 timeoutMs 2500 maxInflight 32   -- 1% trickle
--   HSET system:feed-shadow sampleRate 0                                     -- off
--
-- FEED_SERVICE_URL (env) is the feed service base URL; unset leaves shadow mode inert.

CREATE TABLE IF NOT EXISTS default.feedShadow
(
  time DateTime64(3),
  traceId String,
  userId UInt32,
  sort LowCardinality(String),
  period LowCardinality(String),
  browsingLevel UInt16,
  useCombinedNsfwLevel UInt8,
  cursor String,
  -- allowlisted query-shape keys of the search input as JSON (same allowlist as feedRequests)
  input String,
  -- query string sent to the candidate; empty when skipped
  feedQuery String,
  -- why the search could not be mirrored (input:<key>, flag:<name>, offset>N, ...); empty when it was
  skipReason LowCardinality(String),
  feedStatus UInt16,
  feedMs UInt32,
  feedRoute LowCardinality(String),
  feedEstimate UInt32,
  feedCandidates UInt32,
  feedCount UInt16,
  feedIds Array(UInt32),
  meiliMs UInt32,
  meiliCount UInt16,
  meiliIds Array(UInt32),
  -- |meili ∩ feed| / |meili|, and the same over the first 10
  overlap Float32,
  overlapTop10 Float32,
  -- first position where the two orders differ; -1 when the shorter list is a prefix of the other
  firstMismatch Int32,
  error UInt8
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY time
TTL toDateTime(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Coverage and agreement over the last hour:
--
--   SELECT skipReason, count() FROM feedShadow WHERE time > now() - INTERVAL 1 HOUR GROUP BY 1 ORDER BY 2 DESC;
--   SELECT sort, period, count(), avg(overlap), quantile(0.5)(feedMs), quantile(0.99)(feedMs),
--          quantile(0.5)(meiliMs), quantile(0.99)(meiliMs)
--   FROM feedShadow WHERE time > now() - INTERVAL 1 HOUR AND skipReason = '' GROUP BY 1, 2 ORDER BY 3 DESC;
