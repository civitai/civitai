# Split Model Metrics Job

**Status: Implemented**

## Problem
The model metrics job is too heavy and runs every minute, overwhelming the workers.

## Solution
Split into 3 separate jobs:
1. **Main model metrics job** (`update-metrics-models`) - every 1 minute
2. **Model collection metrics job** (`update-metrics-model-collections`) - every 5 minutes
3. **BaseModel metrics job** (`update-metrics-basemodels`) - every 5 minutes

## Implementation

### 1. Create `model-collection.metrics.ts`
Extract the collection metrics logic into its own processor:
- `getCollectionTasks()` function (uses `getEntityMetricTasks`)
- Bulk insert updates to `ModelMetric` table for `collectedCount`
- Queue search index updates for affected models

### 2. Create `basemodel.metrics.ts`
Extract the base model aggregation logic:
- `getBaseModelAggregationTasks()` function
- `bulkInsertBaseModelMetrics()` function
- Works with `ModelBaseModelMetric` table

### 3. Modify `model.metrics.ts`
Remove:
- `getCollectionTasks()` call from model tasks
- `getBaseModelAggregationTasks()` and `bulkInsertBaseModelMetrics()` calls

### 4. Update `update-metrics.ts`
Add new entries to `metricSets`:
```typescript
const metricSets = {
  models: [metrics.modelMetrics],
  'model-collections': [metrics.modelCollectionMetrics],  // NEW - every 5 min
  basemodels: [metrics.baseModelMetrics],                 // NEW - every 5 min
  // ... rest
};
```

Update job creation to support per-metric-set cron schedules:
```typescript
const metricSchedules: Record<string, string> = {
  'model-collections': '*/5 * * * *',  // every 5 minutes
  basemodels: '*/5 * * * *',           // every 5 minutes
};
```

## Files to Modify/Create

| File | Action |
|------|--------|
| `src/server/metrics/model.metrics.ts` | Modify - remove collection and basemodel logic |
| `src/server/metrics/model-collection.metrics.ts` | Create - collection metrics processor |
| `src/server/metrics/basemodel.metrics.ts` | Create - base model metrics processor |
| `src/server/metrics/index.ts` | Modify - export new processors |
| `src/server/jobs/update-metrics.ts` | Modify - add schedule customization |

## Benefits
- Reduces load on the per-minute workers
- Collection metrics naturally fit a 5-minute cycle (they use a 5-minute agg boundary)
- BaseModel aggregation is expensive and doesn't need per-minute freshness
