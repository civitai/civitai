# Slow Database Queries Analysis

## Overview
This document contains queries from PgHero dashboard that have average execution times longer than 60 seconds. These queries are causing blocking and unnecessary WAL (Write-Ahead Logging) growth and require immediate optimization.

## Optimization Status

**Last Updated:** 2025-08-13

### ✅ Refactoring Completed
- **Collection Metrics** - `src/server/metrics/collection.metrics.ts`
- **Model Metrics** - `src/server/metrics/model.metrics.ts`
- **User Metrics** - `src/server/metrics/user.metrics.ts`
- **Tag Metrics** - `src/server/metrics/tag.metrics.ts`
- **Article Metrics** - `src/server/metrics/article.metrics.ts`
- **Bounty Metrics** - `src/server/metrics/bounty.metrics.ts`
- **Bounty Entry Metrics** - `src/server/metrics/bountyEntry.metrics.ts`

### ⚠️ Pending Optimizations
- **Post Metrics** - Different pattern, needs specialized optimization
- **Image Metrics** - Currently disabled, lower priority
- **Image Resource Bulk Insert** - `src/server/services/image.service.ts:5081`
- **Image Ingestion Query** - `src/server/jobs/image-ingestion.ts:22`

## Critical Slow Queries (>60s average execution time)

### 1. Collection Metric Update Query
**Average Time:** 826,594 ms (13.7 minutes)
**Total Time:** 1,571 minutes
**Calls:** 114
**Code Location:** `src/server/metrics/collection.metrics.ts:99`
**Query:**
```sql
-- update collection item metrics
INSERT INTO "CollectionMetric" ("collectionId", timeframe, "itemCount")
SELECT
  "collectionId",
  tf.timeframe,
  SUM(CASE
    WHEN tf.timeframe = 'AllTime' THEN 1
    WHEN tf.timeframe = 'Year' AND "createdAt" > (NOW() - interval '365 days') THEN 1
    WHEN tf.timeframe = 'Month' AND "createdAt" > (NOW() - interval '30 days') THEN 1
    WHEN tf.timeframe = 'Week' AND "createdAt" > (NOW() - interval '7 days') THEN 1
    WHEN tf.timeframe = 'Day' AND "createdAt" > (NOW() - interval '1 days') THEN 1
    ELSE 0
  END) as "itemCount"
FROM "CollectionItem"
CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
WHERE "collectionId" IN (/* 1000+ collection IDs */)
GROUP BY "collectionId", tf.timeframe
ON CONFLICT ("collectionId", timeframe) DO UPDATE
  SET "itemCount" = EXCLUDED."itemCount", "updatedAt" = NOW()
```
**Issues:**
- Processing 1000+ collection IDs in a single query
- CROSS JOIN with multiple timeframes creates cartesian product
- Multiple aggregations per collection per timeframe
- No batching or pagination

### 2. Image Resource Insertion Query
**Average Time:** 695,267 ms (11.5 minutes)
**Total Time:** 11,704 minutes
**Calls:** 1,010
**Code Location:** `src/server/services/image.service.ts:5081`
**Query:**
```sql
INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId", strength, detected)
VALUES ($1, $2, $3, $4),($5, $6, $7, $8),($9, $10, $11, $12),($13, $14, $15, $16),($17, $18, $19, $20)
ON CONFLICT ("imageId", "modelVersionId") DO UPDATE
SET
  detected = excluded.detected,
  strength = excluded.strength
```
**Issues:**
- Bulk upsert operations without proper indexing
- Potential lock contention on ImageResourceNew table
- No batch size optimization

### 3. Image Ingestion Status Query
**Average Time:** 636,284 ms (10.6 minutes)
**Total Time:** 7,317 minutes
**Calls:** 690
**Code Location:** `src/server/jobs/image-ingestion.ts:22`
**Query:**
```sql
SELECT id, url, type, width, height, meta->>'prompt' as prompt
FROM "Image"
WHERE (
    ingestion = $1::"ImageIngestionStatus"
    AND ("scanRequestedAt" IS NULL OR "scanRequestedAt" <= now() - $2::interval)
  ) OR (
    ingestion = $3::"ImageIngestionStatus"
    AND "scanRequestedAt" <= now() - $4::interval
    AND ("scanJobs"->>'$7')::int < $5
  )
```
**Issues:**
- Complex OR conditions preventing index usage
- JSON field access in WHERE clause
- No LIMIT clause for batch processing
- Missing indexes on ingestion status and scanRequestedAt

### 4. User Engagement Metrics Update
**Average Time:** 631,335 ms (10.5 minutes)
**Total Time:** 1,031 minutes
**Calls:** 98
**Code Location:** `src/server/metrics/user.metrics.ts:67`
**Query:**
```sql
-- update tag engagement metrics
INSERT INTO "UserMetric" ("userId", timeframe, "followerCount", "hiddenCount")
SELECT
  "targetUserId",
  tf.timeframe,
  SUM(CASE /* complex conditional aggregation */) "followerCount",
  SUM(CASE /* complex conditional aggregation */) "hiddenCount"
FROM "UserEngagement" e
CROSS JOIN (SELECT unnest(enum_range($35::"MetricTimeframe")) AS timeframe) tf
WHERE "targetUserId" IN (/* 1000+ user IDs */)
GROUP BY "targetUserId", tf.timeframe
ON CONFLICT ("userId", timeframe) DO UPDATE
  SET "followerCount" = EXCLUDED."followerCount", 
      "hiddenCount" = EXCLUDED."hiddenCount", 
      "updatedAt" = NOW()
```
**Issues:**
- Processing 1000+ user IDs in single query
- Complex CASE statements with date comparisons
- CROSS JOIN creating large intermediate result set
- Missing indexes on targetUserId and createdAt

### 5. Model Collection Metrics Update
**Average Time:** 474,290 ms (7.9 minutes)
**Total Time:** 3,043 minutes
**Calls:** 385
**Code Location:** `src/server/metrics/model.metrics.ts:506`
**Query:**
```sql
-- update model collect metrics
WITH Timeframes AS (
  SELECT unnest(enum_range($1::"MetricTimeframe")) AS timeframe
)
INSERT INTO "ModelMetric" ("modelId", timeframe, "collectedCount")
SELECT
  c."modelId",
  tf.timeframe,
  COUNT(DISTINCT c."addedById") AS "collectedCount"
FROM "CollectionItem" c
JOIN Timeframes tf ON /* multiple date range conditions */
JOIN "Model" m ON m.id = c."modelId"
WHERE c."modelId" = ANY (ARRAY[/* 1000+ model IDs */])
  AND c."modelId" BETWEEN $1011 AND $1012
GROUP BY c."modelId", tf.timeframe
ON CONFLICT ("modelId", timeframe) DO UPDATE
  SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = now()
```
**Issues:**
- Processing 1000+ model IDs
- COUNT(DISTINCT) is expensive operation
- Multiple JOIN conditions with date comparisons
- Large parameter arrays

### 6. Model Rating Metrics Update
**Average Time:** 364,226 ms (6 minutes)
**Total Time:** 2,131 minutes
**Calls:** 351
**Code Location:** `src/server/metrics/model.metrics.ts:429`
**Query:**
```sql
-- update model rating metrics
INSERT INTO "ModelMetric" ("modelId", timeframe, "thumbsUpCount", "thumbsDownCount")
SELECT
  r."modelId",
  tf.timeframe,
  COUNT(DISTINCT CASE /* complex conditional */) "thumbsUpCount",
  COUNT(DISTINCT CASE /* complex conditional */) "thumbsDownCount"
FROM "ResourceReview" r
CROSS JOIN (SELECT unnest(enum_range($23::"MetricTimeframe")) AS timeframe) tf
WHERE r.exclude = $24
  AND r."tosViolation" = $25
  AND r."modelId" IN (/* 1000+ model IDs */)
GROUP BY r."modelId", tf.timeframe
ON CONFLICT ("modelId", timeframe) DO UPDATE
  SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", 
      "thumbsDownCount" = EXCLUDED."thumbsDownCount", 
      "updatedAt" = now()
```
**Issues:**
- Processing 1000+ model IDs in single query
- Multiple COUNT(DISTINCT) operations
- Complex CASE statements in aggregation
- CROSS JOIN with timeframes

### 7. Post Image Reactions Query
**Average Time:** 277,662 ms (4.6 minutes)
**Total Time:** 190 minutes
**Calls:** 41
**Query:**
```sql
-- get recent post image reactions
SELECT DISTINCT
  i."postId" AS id
FROM "Image" i
WHERE i.id IN (/* large list of image IDs */)
```
**Issues:**
- Large IN clause with potentially thousands of IDs
- DISTINCT operation on large result set
- Missing index optimization

## Code Organization Analysis

### Metrics System Files
The slow queries are primarily concentrated in the metrics update system:

1. **Collection Metrics** (`src/server/metrics/collection.metrics.ts`)
   - Updates follower counts, contributor counts, and item counts
   - Processes massive lists of collection IDs in single queries

2. **Model Metrics** (`src/server/metrics/model.metrics.ts`)
   - Lines 429-444: Rating metrics (thumbs up/down counts)
   - Lines 506-521: Collection metrics (collected counts)
   - Both use CROSS JOIN with timeframes causing cartesian products

3. **User Metrics** (`src/server/metrics/user.metrics.ts`)
   - Line 67: Updates follower and hidden counts
   - Processes 1000+ user IDs at once

4. **Image Processing**
   - `src/server/services/image.service.ts:5081`: Bulk resource insertions
   - `src/server/jobs/image-ingestion.ts:22`: Image ingestion job queries

### Key Pattern: All metric queries follow same anti-pattern
- Use CROSS JOIN with timeframes (AllTime, Year, Month, Week, Day)
- Process thousands of IDs in single queries
- Use complex CASE statements for conditional aggregation
- No batching or pagination

## Common Performance Issues

1. **Large IN clauses**: Most queries process 1000+ IDs in single queries
2. **CROSS JOIN with timeframes**: Creates cartesian products leading to massive intermediate results
3. **COUNT(DISTINCT)**: Expensive operations on large datasets
4. **Complex CASE statements**: Multiple conditional aggregations within single queries
5. **Missing indexes**: Many queries lack proper indexing on filter columns
6. **No batching**: Processing entire datasets instead of chunking

## Immediate Optimization Recommendations

### 1. Implement Batch Processing
- Break large ID lists into chunks of 100-200 IDs
- Process chunks in parallel where possible
- Use cursor-based pagination for large datasets

### 2. Add Critical Indexes
```sql
-- CollectionItem indexes
CREATE INDEX idx_collection_item_collection_created 
  ON "CollectionItem" ("collectionId", "createdAt");

-- Image indexes  
CREATE INDEX idx_image_ingestion_scan 
  ON "Image" ("ingestion", "scanRequestedAt");

-- UserEngagement indexes
CREATE INDEX idx_user_engagement_target_created 
  ON "UserEngagement" ("targetUserId", "createdAt");

-- ResourceReview indexes
CREATE INDEX idx_resource_review_model_created 
  ON "ResourceReview" ("modelId", "createdAt") 
  WHERE exclude = false AND "tosViolation" = false;
```

### 3. Optimize Metric Calculations
- Pre-calculate metrics in background jobs
- Use materialized views for frequently accessed aggregations
- Consider using incremental updates instead of full recalculations

### 4. Query Refactoring
- Replace CROSS JOIN with more efficient JOIN strategies
- Use window functions instead of multiple aggregations
- Implement partial indexes for common filter conditions

### 5. Connection Pooling & Timeouts
- Set appropriate statement timeouts (60s max)
- Implement connection pooling to prevent connection exhaustion
- Add circuit breakers for long-running queries

## Long-term Solutions

1. **Implement CQRS pattern**: Separate read and write models for metrics
2. **Use time-series database**: Consider TimescaleDB for time-based metrics
3. **Async processing**: Move metric calculations to background queues
4. **Read replicas**: Offload analytical queries to dedicated replicas
5. **Data partitioning**: Partition large tables by date or ID ranges

## Monitoring Actions

1. Set up alerts for queries exceeding 60 seconds
2. Monitor WAL growth during metric update periods
3. Track blocking queries and lock wait times
4. Implement query performance regression tests
5. Regular VACUUM and ANALYZE operations

## Priority Order

1. **CRITICAL**: Add missing indexes (immediate)
2. **HIGH**: Implement batch processing for collection and model metrics
3. **HIGH**: Optimize Image ingestion status queries
4. **MEDIUM**: Refactor CROSS JOIN queries
5. **MEDIUM**: Set up monitoring and alerting
6. **LOW**: Implement long-term architectural changes

---
*Data source: PgHero dashboard query analysis*
*Note: Query execution times based on actual production metrics*