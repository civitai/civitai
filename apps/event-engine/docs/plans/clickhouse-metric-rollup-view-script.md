Please create a script that will connect to ClickHouse and go through the process of setting up the backing table, creating the Materialized View, keeping track when Materialized View was created, and then using that to then backfill the backing table month by month, starting from a variable date (default '2022-11-01'). And let's go one month at a time.

**Existing Script:**
```sql
-- Backing table
DROP TABLE IF EXISTS entityMetricDailyAgg;
CREATE TABLE entityMetricDailyAgg
(
    entityType LowCardinality(String),
    entityId   Int32,
    metricType LowCardinality(String),
    day        Date,
    total      Int64
)
ENGINE = SummingMergeTree
ORDER BY (entityType, entityId, metricType, day)
SETTINGS index_granularity = 8192;

-- Mat view
DROP VIEW IF EXISTS entityMetricDaily;
CREATE MATERIALIZED VIEW entityMetricDaily
TO entityMetricDailyAgg
AS
SELECT
    entityType,
    entityId,
    metricType,
    toDate(createdAt) AS day,
    sum(metricValue) AS total
FROM entityMetricEvents
GROUP BY entityType, entityId, metricType, day;

-- Get time of mat view creation
SELECT now(); -- matViewStart

-- Backfill
INSERT INTO entityMetricDailyAgg
SELECT
    entityType,
    entityId,
    metricType,
    toDate(createdAt) AS day,
    sum(metricValue) AS total
FROM entityMetricEvents
-- WHERE createdAt < matViewStart
-- Process in batches of months using:
-- AND createdAt >= '2025-01-01' AND createdAt < '2025-02-01'
GROUP BY entityType, entityId, metricType, day;

```