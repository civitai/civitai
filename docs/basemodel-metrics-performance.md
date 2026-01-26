# BaseModel Metrics Performance Improvement Plan

## Current Problem
The `basemodel.metrics` job runs every 5 minutes but is taking 10+ minutes to complete, causing it to fall further behind each cycle.

## Root Cause Analysis

### 1. Sequential Task Execution
```typescript
// Line 51 - tasks run one-by-one
for (const task of baseModelTasks) await task();
```
Each batch waits for the previous one to complete instead of running in parallel.

### 2. Heavy Query Per Batch
Each batch executes a complex query with two CTEs:
- `version_stats`: JOINs `ModelVersionMetric` → `ModelVersion`
- `review_stats`: JOINs `ResourceReview` → `ModelVersion` with `COUNT(DISTINCT userId)`

These are joined together, creating significant per-batch overhead.

### 3. Scope Creep When Behind
When the job falls behind, `lastUpdate` gets further in the past, causing more models to be "affected" in each run, creating a cascading failure.

### 4. Inefficient Query Pattern
The query uses `modelId = ANY($1::int[])` AND `modelId BETWEEN $2 AND $3`, which may not use indexes optimally.

---

## Proposed Solutions

### Option A: Parallel Batch Execution (Quick Win)
Change sequential execution to parallel with concurrency limit:

```typescript
// Before (sequential)
for (const task of baseModelTasks) await task();

// After (parallel with limit)
await limitConcurrency(baseModelTasks, 5);
```

**Estimated improvement**: 3-5x faster (assuming 5 concurrent batches)

### Option B: Increase Batch Size
```typescript
// Before
const BATCH_SIZE = 200;

// After
const BATCH_SIZE = 1000;
```

This reduces the number of round-trips. With 10,000 affected models:
- Old: 50 batches × sequential = 50 queries
- New: 10 batches × 5 parallel = ~2 rounds of queries

**Estimated improvement**: 2-3x fewer queries

### Option C: Split Review Stats into Separate Job (Major Refactor)
The `COUNT(DISTINCT userId)` on ResourceReview is expensive. We could:

1. Pre-aggregate review stats into a separate table/materialized view
2. Only join the pre-aggregated data in the metrics job

```sql
-- Create materialized view for review counts by baseModel
CREATE MATERIALIZED VIEW mv_review_stats_by_base_model AS
SELECT
  mv."modelId",
  mv."baseModel",
  COUNT(DISTINCT r."userId") FILTER (WHERE r.recommended = true) as "thumbsUpCount"
FROM "ResourceReview" r
JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
WHERE r.exclude = false AND r."tosViolation" = false AND mv."status" = 'Published'
GROUP BY mv."modelId", mv."baseModel";
```

Then refresh this view on a separate schedule and use it in the job.

**Estimated improvement**: 5-10x faster per query

### Option D: Incremental Updates Only
Instead of recalculating all stats for affected models, track deltas:

1. Listen to events (downloads, reviews)
2. Increment/decrement counts directly
3. Only do full recalculation periodically (e.g., daily)

This requires more infrastructure changes but would be the most scalable.

### Option E: Use ClickHouse for Aggregation (Like Model Metrics)
Looking at `model.metrics.ts`, it uses ClickHouse for many aggregations. We could:
1. Track base-model-level events in ClickHouse
2. Query aggregates from ClickHouse instead of PostgreSQL

---

## Recommended Implementation Order

### Phase 1: Quick Wins (Implement Now)
1. **Parallel batch execution** - Change `for` loop to `limitConcurrency`
2. **Increase batch size** - 200 → 500 or 1000
3. **Add concurrency** to aggregation tasks

### Phase 2: Query Optimization
1. Split the two CTEs into separate parallel queries
2. Consider adding an index on `ModelVersionMetric.updatedAt` if not exists
3. Separate the review aggregation into its own task that runs less frequently

### Phase 3: Architectural Changes (If Needed)
1. Pre-aggregate review stats in a materialized view
2. Consider moving to ClickHouse-based aggregation
3. Implement incremental updates

---

## Implementation Details for Phase 1

### Change 1: Parallel Batch Execution

```typescript
// In getBaseModelAggregationTasks, the tasks are already created
// Just change how they're executed in the update() function

// Before (line 51):
for (const task of baseModelTasks) await task();

// After:
await limitConcurrency(baseModelTasks, 5);
```

### Change 2: Increase Batch Size

```typescript
// Line 11
const BATCH_SIZE = 500; // Was 200
```

### Change 3: Split Aggregation into Two Parallel Paths

```typescript
// Split version_stats and review_stats into separate concurrent queries
// Then merge results after both complete

const [versionStats, reviewStats] = await Promise.all([
  getVersionStatsForBatch(ctx, ids),
  getReviewStatsForBatch(ctx, ids),
]);

// Merge results
for (const vs of versionStats) {
  const key = `${vs.modelId}:${vs.baseModel}`;
  ctx.baseModelUpdates[key] = {
    modelId: vs.modelId,
    baseModel: vs.baseModel,
    downloadCount: vs.downloadCount,
    imageCount: vs.imageCount,
    thumbsUpCount: 0, // Will be filled by review stats
  };
}

for (const rs of reviewStats) {
  const key = `${rs.modelId}:${rs.baseModel}`;
  if (ctx.baseModelUpdates[key]) {
    ctx.baseModelUpdates[key].thumbsUpCount = rs.thumbsUpCount;
  } else {
    // Model has reviews but no version metrics (edge case)
    ctx.baseModelUpdates[key] = {
      modelId: rs.modelId,
      baseModel: rs.baseModel,
      downloadCount: 0,
      imageCount: 0,
      thumbsUpCount: rs.thumbsUpCount,
    };
  }
}
```

---

## Metrics to Track

After implementing changes, monitor:
1. Job execution time (should drop from 10+ min to < 5 min)
2. Number of affected models per run
3. Database query times for individual batches
4. Queue buildup (should stay near zero)

---

## Questions for Review

1. Should we run thumbsUp aggregation less frequently (every 15-30 min instead of 5)?
2. Do we need real-time accuracy on these metrics, or is eventual consistency okay?
3. Is there existing ClickHouse infrastructure we can leverage for this?

---

## Implementation Status

### Phase 1 Changes (Implemented)

The following optimizations have been implemented in `src/server/metrics/basemodel.metrics.ts`:

#### 1. Parallel Batch Execution
```typescript
// Before (sequential)
for (const task of baseModelTasks) await task();

// After (parallel with 5 concurrent batches)
await limitConcurrency(baseModelTasks, AGGREGATION_CONCURRENCY);
```

#### 2. Increased Batch Size
```typescript
// Before
const BATCH_SIZE = 200;

// After
const BATCH_SIZE = 500;
```

#### 3. Split Queries Run in Parallel
Each batch now runs two separate queries concurrently:
- `getVersionStatsForBatch()` - aggregates downloadCount and imageCount
- `getReviewStatsForBatch()` - aggregates thumbsUpCount

```typescript
const [versionStats, reviewStats] = await Promise.all([
  getVersionStatsForBatch(ctx, ids),
  getReviewStatsForBatch(ctx, ids),
]);
```

#### 4. Increased Insert Batch Size
```typescript
// Before
chunk(updates, 100)

// After
chunk(updates, 250)
```

### Expected Performance Improvement

With 10,000 affected models:

| Metric | Before | After |
|--------|--------|-------|
| Batches | 50 | 20 |
| Concurrent batches | 1 | 5 |
| Effective rounds | 50 | 4 |
| Queries per batch | 1 (combined) | 2 (parallel) |
| Total query time | ~sequential | ~parallel |

**Estimated speedup: 5-10x** depending on database load and query times.
