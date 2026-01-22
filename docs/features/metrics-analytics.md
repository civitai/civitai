# Metrics & Analytics

Track events and metrics using ClickHouse for analytics and reporting.

## Overview

The metrics system uses ClickHouse for high-volume event tracking and analytics. It supports:
- Entity-level metrics (views, downloads, likes, etc.)
- User activity tracking
- Custom event tracking
- Real-time aggregations

## Key Files

| File | Purpose |
|------|---------|
| `src/server/clickhouse/client.ts` | ClickHouse client and `Tracker` class |
| `src/server/utils/metric-helpers.ts` | Helper functions |
| `src/server/metrics/` | Metric processors by entity type |
| `src/server/metrics/base.metrics.ts` | Metric processor factory |

## Entity Metrics

### Tracking Events

```typescript
// In a tRPC procedure or service
await ctx.track.entityMetric({
  entityType: 'Model',
  entityId: modelId,
  metricType: 'Download',
  metricValue: 1,
});

// Common metric types:
// - View, Download, Like, Dislike, Comment, Share
```

### ClickHouse Schema

```sql
CREATE TABLE entityMetricEvents (
  entityType LowCardinality(String),
  entityId   Int32,
  userId     Int32,
  metricType LowCardinality(String),
  metricValue Int32,
  createdAt  DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (entityType, entityId, createdAt);
```

## Custom Event Tables

For high-volume or specialized tracking, create dedicated tables:

```sql
CREATE TABLE my_feature_events (
  feature_id UInt32,
  user_id UInt32,
  action LowCardinality(String),
  metadata String,  -- JSON for flexible data
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (feature_id, created_at)
TTL created_at + INTERVAL 90 DAY;  -- Auto-cleanup old data
```

## Buffer Tables

ClickHouse prefers batch inserts. Use buffer tables for high-frequency writes:

```sql
-- Main table
CREATE TABLE my_events (...) ENGINE = MergeTree() ...;

-- Buffer that auto-flushes to main table
CREATE TABLE my_events_buffer AS my_events
ENGINE = Buffer(
  default,        -- database
  my_events,      -- destination table
  16,             -- num_layers
  10, 100,        -- min/max seconds
  10000, 1000000, -- min/max rows
  10000000, 100000000  -- min/max bytes
);

-- Write to buffer, reads from main table
INSERT INTO my_events_buffer VALUES (...);
SELECT * FROM my_events;  -- Includes buffered data
```

## Querying Metrics

### Aggregations

```typescript
import { clickhouse } from '~/server/clickhouse/client';

const result = await clickhouse.query({
  query: `
    SELECT
      entityId,
      countIf(metricType = 'View') as views,
      countIf(metricType = 'Download') as downloads
    FROM entityMetricEvents
    WHERE entityType = 'Model'
      AND createdAt > now() - INTERVAL 7 DAY
    GROUP BY entityId
    ORDER BY views DESC
    LIMIT 100
  `,
});
```

### Time Series

```typescript
const dailyStats = await clickhouse.query({
  query: `
    SELECT
      toDate(createdAt) as date,
      count() as events
    FROM entityMetricEvents
    WHERE entityType = 'Model' AND entityId = {modelId:UInt32}
    GROUP BY date
    ORDER BY date
  `,
  params: { modelId },
});
```

## Metric Event Watcher

For database-triggered metrics (CDC pattern), see the `metric-event-watcher` service which uses Debezium to:
1. Watch PostgreSQL table changes
2. Process events and update ClickHouse
3. Maintain materialized views for aggregations
