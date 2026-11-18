-- The ClickHouse the integration tier reads (.github/workflows/feed-go.yml applies this file).
--
-- In production entityMetricDailyAgg_v2 is a VIEW returning FINAL per-day totals
-- (event-engine-common/services/metrics.ts). Here it is a plain table with the backing table's
-- columns (metric-event-watcher scripts/setup-clickhouse-rollup-view.ts: entityMetricDailyAgg), under
-- the name the populate query reads, so the query runs unchanged.
CREATE TABLE IF NOT EXISTS entityMetricDailyAgg_v2
(
    entityType LowCardinality(String),
    entityId   Int32,
    metricType LowCardinality(String),
    day        Date,
    total      Int64
)
ENGINE = MergeTree
ORDER BY (entityType, entityId, metricType, day)
