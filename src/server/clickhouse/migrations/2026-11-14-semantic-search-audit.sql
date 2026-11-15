-- semanticSearchAudit: one row per first-page semantic search, written server-side by the app
-- (buffered direct async_insert, same pattern as default.feedRequests). requestId = OTEL traceId.
CREATE TABLE IF NOT EXISTS default.semanticSearchAudit
(
  time DateTime64(3),
  requestId String,
  -- images | models | articles | ...
  searchIndex LowCardinality(String),
  -- viewer; 0 = anonymous
  userId UInt32,
  -- mod | user | anon
  viewerClass LowCardinality(String),
  -- after any narrowing
  browsingLevel UInt16,
  wordVerdict LowCardinality(Nullable(String)),
  -- pass | flag | unknown | unavailable | mismatch | error | none
  guardOutcome LowCardinality(String),
  guardRules Array(String),
  -- off | shadow | enforce
  guardMode LowCardinality(String),
  guardVersion String,
  cacheHit Bool,
  -- first 20 served; empty for refused searches and withheld rules
  resultIds Array(Int64),
  query String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (searchIndex, time)
TTL toDateTime(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;
