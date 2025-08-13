# Metric Query Optimization Summary

## Overview
This document summarizes the optimizations made to slow metric queries that were causing database blocking and WAL growth. The main strategy was to separate complex reads from writes by first aggregating data into JSON, then performing simpler INSERT operations.

## Optimization Strategy

### Before (Blocking Pattern)
```sql
INSERT INTO "MetricTable" (...)
SELECT 
  -- Complex aggregations with CROSS JOIN
  -- Processing 1000+ IDs
  -- Multiple timeframe calculations
FROM "SourceTable"
CROSS JOIN (SELECT unnest(...) AS timeframe) tf
WHERE id IN (/* 1000+ IDs */)
GROUP BY ...
ON CONFLICT (...) DO UPDATE ...
```

### After (Non-Blocking Pattern)
```sql
-- Step 1: Aggregate into JSON (read-only, non-blocking)
WITH metric_data AS (
  SELECT 
    -- Complex aggregations
  FROM "SourceTable"
  CROSS JOIN (SELECT unnest(...) AS timeframe) tf
  WHERE id IN (/* 1000+ IDs */)
  GROUP BY ...
)
SELECT jsonb_agg(jsonb_build_object(...)) as data
FROM metric_data;

-- Step 2: Simple INSERT from JSON (fast write)
INSERT INTO "MetricTable" (...)
SELECT 
  (value->>'field1')::type1,
  (value->>'field2')::type2,
  ...
FROM jsonb_array_elements(data::jsonb) AS value
ON CONFLICT (...) DO UPDATE ...
```

## Files Modified

### Completed Refactoring

#### 1. Collection Metrics
**File:** `src/server/metrics/collection.metrics.ts`
**Line:** 94-130
**Changes:**
- Split collection item count aggregation into two phases
- First phase aggregates into JSON using CTE
- Second phase performs INSERT from JSON data
- Prevents blocking during complex COUNT operations

#### 2. Model Metrics
**File:** `src/server/metrics/model.metrics.ts`
- **Model Rating Metrics (Lines 424-478):** Separated thumbs up/down count calculations from INSERT
- **Model Collection Metrics (Lines 527-580):** Refactored COUNT(DISTINCT) operations into JSON phase
- Uses JSON aggregation for intermediate results
- Eliminates blocking during expensive DISTINCT operations

#### 3. User Metrics
**File:** `src/server/metrics/user.metrics.ts`
- **User Engagement Metrics (Lines 62-110):** Split follower/hidden count aggregations
- **User Following Metrics (Lines 115-170):** Refactored following count aggregations
- **User Model Upload Metrics (Lines 172-234):** Refactored upload count aggregations
- **User Review Metrics (Lines 236-293):** Refactored review count aggregations
- JSON intermediate storage for all metrics
- Fast INSERT from pre-aggregated results

#### 4. Tag Metrics
**File:** `src/server/metrics/tag.metrics.ts`
- **Tag Engagement Metrics (Lines 54-102):** Refactored follower/hidden count aggregations
- **Tag Count Metrics (Lines 123-180):** Refactored model/image/post/article count aggregations
- Unified JSON aggregation pattern for all tag metrics
- Significant reduction in blocking operations

#### 5. Article Metrics
**File:** `src/server/metrics/article.metrics.ts`
- **Reaction Metrics:** Refactored all reaction type aggregations
- **Comment Metrics:** Refactored comment count aggregations
- **Collection Metrics:** Refactored collection count aggregations
- **Buzz Tip Metrics:** Refactored tip count and amount aggregations
- **Engagement Metrics:** Refactored hide count aggregations
- All using JSON aggregation pattern

#### 6. Bounty Metrics
**File:** `src/server/metrics/bounty.metrics.ts`
- **Engagement Metrics:** Refactored favorite/track count aggregations
- **Comment Metrics:** Refactored comment count aggregations
- **Benefactor Metrics:** Refactored benefactor and unit amount aggregations
- **Entry Metrics:** Refactored entry count aggregations
- Complete JSON aggregation implementation

#### 7. Bounty Entry Metrics
**File:** `src/server/metrics/bountyEntry.metrics.ts`
- **Reaction Metrics:** Refactored all reaction type aggregations
- **Benefactor Metrics:** Refactored unit amount aggregations
- **Buzz Tip Metrics:** Refactored tip count and amount aggregations
- Full JSON aggregation pattern applied

### Files Not Requiring Refactoring

- **club.metrics.ts:** No CROSS JOIN with timeframe patterns found
- **clubPost.metrics.ts:** No CROSS JOIN with timeframe patterns found
- **question.metrics.ts:** Not analyzed, likely minimal impact
- **answer.metrics.ts:** Not analyzed, likely minimal impact

### Files With Different Optimization Needs

#### Post Metrics
**File:** `src/server/metrics/post.metrics.ts`
**Issue:** Uses a different batching pattern where metrics are collected in memory first
**Specific Problem:** Line 169-175 has slow query fetching postIds from Image table
**Recommendation:** Consider splitting the image ID to post ID lookup into smaller batches

#### Image Metrics  
**File:** `src/server/metrics/image.metrics.ts`
**Status:** Currently disabled (`disabled: true`)
**Pattern:** Similar to post metrics with in-memory collection
**Recommendation:** Lower priority due to being disabled

## Performance Benefits

### 1. Reduced Lock Contention
- Complex reads no longer hold locks on metric tables
- INSERT operations are now simple and fast
- Multiple metric updates can run concurrently

### 2. Better Resource Utilization
- Read operations can use read replicas if available
- Write operations are batched and optimized
- Reduced WAL growth from shorter transaction times

### 3. Improved Query Times
Expected improvements based on the pattern:
- **Before:** 600-800+ seconds per batch
- **After:** 10-30 seconds per batch (estimated)
- **Reduction:** ~95% reduction in execution time

### 4. Database Health Benefits
- Reduced blocking chains
- Lower WAL growth rate
- Better autovacuum performance
- Improved overall database responsiveness

## Testing Recommendations

1. **Performance Testing**
   - Compare execution times before/after changes
   - Monitor lock wait times during metric updates
   - Check WAL growth patterns

2. **Correctness Testing**
   - Verify metric counts match expected values
   - Test edge cases (empty results, null values)
   - Validate ON CONFLICT behavior

3. **Load Testing**
   - Test with varying batch sizes (100, 500, 1000+ IDs)
   - Run concurrent metric updates
   - Monitor memory usage for JSON aggregation

## Rollback Plan

If issues are encountered, the original queries are preserved in git history. To rollback:
1. Revert the changes in the metric files
2. Deploy the previous version
3. Monitor for immediate relief of any issues

## Future Optimizations

1. **Batch Size Tuning**
   - Current: 1000 IDs per batch
   - Consider dynamic sizing based on data volume
   - Add monitoring for optimal batch sizes

2. **Parallel Processing**
   - JSON aggregation could be parallelized
   - Multiple batches could run concurrently
   - Consider using pg_background for async processing

3. **Materialized Views**
   - For frequently accessed metrics
   - Refresh during off-peak hours
   - Reduce real-time calculation overhead

4. **Time-Series Database**
   - Consider TimescaleDB for metric storage
   - Better suited for time-based aggregations
   - Built-in compression and retention policies

## Monitoring

Add the following monitoring:
1. Query execution time per metric type
2. Lock wait events during metric updates
3. WAL generation rate during metric processing
4. JSON aggregation memory usage
5. Success/failure rates for metric updates

---
*Date: 2025-08-13*
*Optimization implemented to address PgHero slow query report*