---
name: clickhouse-query
description: Run ClickHouse queries for analytics, metrics analysis, and event data exploration. Use when you need to query ClickHouse directly, analyze metrics, check event tracking data, or test query performance. Read-only by default.
---

# ClickHouse Query Testing

Use this skill to run ad-hoc ClickHouse queries for analytics, metrics analysis, and debugging.

## Running Queries

Use the included query script:

```bash
node .claude/skills/clickhouse-query/query.mjs "SELECT count() FROM views"
```

### Options

| Flag | Description |
|------|-------------|
| `--explain` | Show query execution plan |
| `--writable` | Allow write operations (requires user permission) |
| `--timeout <s>`, `-t` | Query timeout in seconds (default: 30) |
| `--file`, `-f` | Read query from a file |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output, only results |

### Examples

```bash
# Count rows in a table
node .claude/skills/clickhouse-query/query.mjs "SELECT count() FROM views"

# Query with filters
node .claude/skills/clickhouse-query/query.mjs "SELECT * FROM modelEvents WHERE modelId = 123 LIMIT 10"

# Check query execution plan
node .claude/skills/clickhouse-query/query.mjs --explain "SELECT * FROM views WHERE userId = 1"

# Override default 30s timeout for longer queries
node .claude/skills/clickhouse-query/query.mjs --timeout 60 "SELECT ... (complex aggregation)"

# Query from file
node .claude/skills/clickhouse-query/query.mjs -f my-query.sql

# JSON output for processing
node .claude/skills/clickhouse-query/query.mjs --json "SELECT type, count() FROM modelEvents GROUP BY type"
```

## Safety Features

1. **Read-only by default**: Blocks INSERT/ALTER/DROP unless `--writable` flag is used
2. **30 second timeout**: Prevents runaway queries (override with `--timeout`)
3. **Explicit permission required**: Before using `--writable`, you MUST ask the user for permission

## When to Use --writable

Only use the `--writable` flag when:
- The user explicitly requests write access
- You need to insert test data
- You're running maintenance operations

**IMPORTANT**: Always ask the user for permission before running with `--writable`.

## Common Tables

| Table | Description |
|-------|-------------|
| `views` | Page/entity view events |
| `modelEvents` | Model create/publish/update events |
| `modelVersionEvents` | Model version events including downloads |
| `userActivities` | User registration, login, subscription events |
| `images` | Image upload/delete events |
| `reactions` | Like/dislike events |
| `reports` | Content report events |
| `entityMetricEvents` | Aggregated metric events |

## Querying Replica Clusters

**IMPORTANT**: Production uses a ClickHouse replica cluster. When querying system tables (logs, metrics, etc.), you must use `clusterAllReplicas()` to get data from all nodes.

### System Tables on Replica Clusters

```sql
-- WRONG: Only queries the node you're connected to
SELECT * FROM system.query_log WHERE event_time > now() - INTERVAL 1 HOUR

-- CORRECT: Queries all replicas in the cluster
SELECT * FROM clusterAllReplicas(default, system.query_log)
WHERE event_time > now() - INTERVAL 1 HOUR
```

### Common System Table Queries

```sql
-- Find recent queries across all nodes
SELECT
    hostname(),
    event_time,
    query_duration_ms,
    formatReadableSize(memory_usage) AS memory,
    query
FROM clusterAllReplicas(default, system.query_log)
WHERE type = 'QueryFinish'
    AND event_time > now() - INTERVAL 5 MINUTE
ORDER BY event_time DESC
LIMIT 20

-- Find expensive queries by memory usage (last 24 hours)
SELECT
    count() as query_count,
    user,
    sum(memory_usage) AS total_memory,
    normalized_query_hash
FROM clusterAllReplicas(default, system.query_log)
WHERE event_time > now() - INTERVAL 1 DAY
    AND query_kind = 'Select'
    AND type = 'QueryFinish'
GROUP BY normalized_query_hash, user
ORDER BY total_memory DESC
LIMIT 10

-- Search query logs by pattern
SELECT event_time, query_id, query, type
FROM clusterAllReplicas(default, merge('system', '^query_log*'))
WHERE query ILIKE '%some_table%'
    AND event_time > now() - INTERVAL 5 MINUTE

-- Debug a specific query across all nodes
SELECT hostname(), message
FROM clusterAllReplicas(default, system.text_log)
WHERE query_id = 'your-query-id-here'
ORDER BY event_time_microseconds ASC
```

### When to Use clusterAllReplicas()

| Use Case | Function |
|----------|----------|
| System tables (query_log, text_log, etc.) | `clusterAllReplicas(default, system.table_name)` |
| Application tables (views, modelEvents, etc.) | Direct query (already distributed) |
| Search multiple system tables | `clusterAllReplicas(default, merge('system', '^pattern*'))` |

## ClickHouse SQL Tips

```sql
-- Use count() not COUNT(*)
SELECT count() FROM views

-- Date filtering with toDate()
SELECT * FROM views WHERE toDate(time) = today()

-- Last 7 days
SELECT * FROM modelEvents WHERE time > now() - INTERVAL 7 DAY

-- Aggregations
SELECT type, count() as cnt FROM modelEvents GROUP BY type ORDER BY cnt DESC
```
