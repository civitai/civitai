-- Jev resource-intent shadow event — ClickHouse DDL. Apply MANUALLY (we do not
-- auto-run DDL; same policy as the Postgres migrations).
--
-- One row per resource-intent request (POST /api/v1/blocks/resource-intent):
-- the hashed prompt, the stage-1 intent distributions (summary values), the
-- matcher's shortlist size, the suggestion ids that shipped, and how/whether the
-- call degraded. The prompt itself is NOT stored — only its sha256 + length, so
-- the same prompt is groupable without turning this table into a prompt corpus.
--
-- Consumers:
--   - the M4 gate: shadow volume >= 1k/day for 7 days (any degraded<1 breakdown)
--   - fallback-rate monitoring (degraded + degradedReason)
--   - the threshold study (scripts/eval-resource-intent-goldset.ts reads its own
--     gold-set corpus; this table is the live shadow complement)
--
-- The specHash/specVersion pair rides every row so a question-spec edit
-- invalidates old analytics instead of silently blending with them.

CREATE TABLE IF NOT EXISTS default.resourceIntentShadow
(
  time DateTime64(3),
  promptHash String,
  promptLength UInt32,
  baseModel String,
  browsingLevel UInt16,
  specHash String,
  specVersion UInt16,
  criteriaVersion UInt16,
  model String,
  degraded UInt8,
  degradedReason LowCardinality(String),
  latencyMs UInt32,
  role LowCardinality(String),
  styleFamily LowCardinality(String),
  contentType LowCardinality(String),
  specificity UInt8,
  needsResource Float32,
  injectionPresent Float32,
  shortlistCount UInt16,
  suggestionIds Array(Int64),
  noneProbability Float32
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (time, promptHash)
TTL toDateTime(time) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Fallback rate over the last day, by reason:
--
--   SELECT degradedReason, count() FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND degraded = 1 GROUP BY 1 ORDER BY 2 DESC;
--
-- Volume + p95 latency for the M4 gate:
--
--   SELECT count(), quantile(0.95)(latencyMs) FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY;
--
-- Role mix (spec-pinned):
--
--   SELECT role, count(), avg(needsResource) FROM resourceIntentShadow
--   WHERE time > now() - INTERVAL 1 DAY AND degraded = 0 AND specVersion = 1
--   GROUP BY 1 ORDER BY 2 DESC;
