# Feed Testing Results

**Date**: 2025-11-04
**Test IDs**: 9173928, 12097475, 64399178

## Summary

Testing infrastructure successfully created for `ImagesFeed.createDocuments`. Documents are being generated correctly, but significant discrepancies found between feed and legacy implementations.

## Test Infrastructure

### Created Files
1. `/event-engine-common/feeds/base.ts` - Added `createDocuments()` method for testing
2. `/src/pages/api/dev-local/test-feed-documents.ts` - Document generation endpoint
3. `/src/pages/api/dev-local/compare-feed-legacy.ts` - Comparison endpoint

### Fixed Issues
- **Cache Array Serialization Bug**: Arrays were being stored as comma-separated strings (`"1,2,3"`) instead of JSON. Fixed by using `JSON.stringify`/`JSON.parse` in cache serialization.

## Test Results

### 🔴 CRITICAL: Metrics Discrepancy

Feed metrics are ~50x lower than legacy metrics:

| ID | Metric | Feed | Legacy | Difference |
|----|--------|------|--------|------------|
| 9173928 | Reactions | 541 | 34,235 | -98.4% |
| 9173928 | Comments | 0 | 58 | -100% |
| 9173928 | Collections | 23 | 1,051 | -97.8% |
| 12097475 | Reactions | 448 | 24,910 | -98.2% |
| 12097475 | Comments | 0 | 24 | -100% |
| 12097475 | Collections | 25 | 1,015 | -97.5% |
| 64399178 | Reactions | 483 | 23,569 | -98.0% |
| 64399178 | Comments | 0 | 27 | -100% |
| 64399178 | Collections | 13 | 283 | -95.4% |

**Root Cause**: Different ClickHouse tables

```typescript
// Legacy (compare-feed-legacy.ts:279)
FROM entityMetricEvents  // Raw event data
WHERE entityType = 'Image'
  AND entityId IN (...)

// Feed MetricService (metrics.ts:292)
FROM entityMetricDailyAgg  // Daily aggregates
WHERE entityType = 'Image'
  AND entityId IN (...)
```

**Issue**: The `entityMetricDailyAgg` table appears to be:
- Not up to date with recent events
- Missing data from aggregation process
- Using different aggregation logic

### ⚠️ MEDIUM: Tag IDs Mismatch

Feed and legacy return different tag lists:

| ID | Feed Tag Count | Legacy Tag Count | Tags Match? |
|----|----------------|------------------|-------------|
| 9173928 | 25 | 20 | ❌ Different tags |
| 12097475 | 34 | 21 | ❌ Different tags |
| 64399178 | 17 | 17 | ❌ Different tags (same count) |

**Example** (ID 9173928):
- Feed first 5 tags: `[66, 81, 292, 1705, 1930]`
- Legacy first 5 tags: `[81, 292, 1930, 3640, 3643]`

**Possible Causes**:
1. Different cache sources (`imageTagIds` vs `tagIdsForImagesCache`)
2. Different filtering logic (disabled tags, etc.)
3. Different sorting or ordering

### ✅ MINOR: publishedAt Field

- Feed includes `publishedAt` field
- Legacy excludes it from response
- **Status**: Acceptable difference (extra field is fine)

## Performance

| Implementation | Avg Time per Document |
|----------------|----------------------|
| Feed | ~995ms (3 docs in 2986ms) |
| Legacy | ~0.3ms (using cached data) |

**Note**: Legacy is faster because it uses already-fetched data in the comparison endpoint. Feed performs actual database queries.

## Recommendations

### 1. Fix Metrics (HIGH PRIORITY)

**Option A**: Update MetricService to use `entityMetricEvents`
```typescript
// In metrics.ts:287-298
FROM entityMetricEvents  // Instead of entityMetricDailyAgg
WHERE entityType = '${entityType}'
  AND entityId IN (${batch})
GROUP BY entityId, metricType
```

**Option B**: Fix the aggregation process for `entityMetricDailyAgg`
- Investigate why the aggregated table is incomplete
- Update aggregation job to include all events

**Option C**: Use both tables
- Use `entityMetricDailyAgg` for performance
- Fall back to `entityMetricEvents` when aggregates are missing

### 2. Investigate Tag Differences (MEDIUM PRIORITY)

Compare the two tag fetching implementations:
- `event-engine-common/caches/imageData.cache.ts` (feed)
- `src/server/redis/caches.ts` (legacy)

Ensure they:
- Query the same table/columns
- Use the same filtering logic
- Handle disabled tags identically

### 3. Testing Endpoints

Use these endpoints for continued testing:

```bash
# Generate documents
curl "http://localhost:3000/api/dev-local/test-feed-documents?ids=9173928,12097475&type=full"

# Compare implementations
curl "http://localhost:3000/api/dev-local/compare-feed-legacy?ids=9173928,12097475"
```

## Next Steps

1. ❗ **Decide on metrics source** - Which table should be the source of truth?
2. **Update MetricService** to use correct table
3. **Re-test** with the same IDs to verify parity
4. **Investigate tag differences** if metrics parity is achieved
5. **Performance testing** with larger batches (100+, 1000+ IDs)
6. **Remove dev endpoints** before production deployment
