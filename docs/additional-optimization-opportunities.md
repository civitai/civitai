# Additional Query Optimization Opportunities

## Overview
After fixing the main slow metric queries, there are additional places in the codebase that could benefit from the same JSON aggregation pattern to prevent database blocking.

## Additional Metric Files Needing Optimization

### 1. Tag Metrics
**File:** `src/server/metrics/tag.metrics.ts`

#### Tag Engagement Metrics (Line 66)
```sql
INSERT INTO "TagMetric" ("tagId", timeframe, "followerCount", "hiddenCount")
SELECT
  "tagId",
  tf.timeframe,
  -- Complex aggregations
FROM "TagEngagement" e
CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
WHERE "tagId" IN (/* batch of IDs */)
GROUP BY "tagId", tf.timeframe
```
**Issue:** Same CROSS JOIN pattern with timeframes

#### Tag Count Metrics (Line 116)
Multiple queries for modelCount, imageCount, postCount, articleCount - all using the same pattern:
```sql
CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
```

### 2. Post Metrics - Image Reactions
**File:** `src/server/metrics/post.metrics.ts`
**Line:** 169-175
```sql
-- get recent post image reactions
SELECT DISTINCT
  i."postId" AS id
FROM "Image" i
WHERE i.id IN (/* large list of image IDs */)
  AND i.id BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
```
**Issue:** Large IN clause with DISTINCT operation
**PgHero Stats:** 277,662 ms average, 190 min total time

### 3. Other Metric Files with Similar Patterns
Based on file structure, these likely have similar issues:
- `src/server/metrics/article.metrics.ts`
- `src/server/metrics/bounty.metrics.ts`
- `src/server/metrics/bountyEntry.metrics.ts`
- `src/server/metrics/club.metrics.ts`
- `src/server/metrics/clubPost.metrics.ts`
- `src/server/metrics/image.metrics.ts`
- `src/server/metrics/question.metrics.ts`
- `src/server/metrics/answer.metrics.ts`

## Non-Metric Optimization Opportunities

### 1. Image Resource Bulk Insert
**File:** `src/server/services/image.service.ts`
**Line:** 5081
**PgHero Stats:** 695,267 ms average (11.5 minutes!)

Current implementation:
```sql
INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId", strength, detected)
VALUES (/* multiple value sets */)
ON CONFLICT ("imageId", "modelVersionId") DO UPDATE
SET
  detected = excluded.detected,
  strength = excluded.strength
```

**Optimization Strategy:**
- Batch the inserts into smaller chunks (100-200 records)
- Consider using COPY instead of INSERT for large batches
- Add appropriate indexes on conflict columns

### 2. Image Ingestion Query
**File:** `src/server/jobs/image-ingestion.ts`
**Line:** 22
**PgHero Stats:** 636,284 ms average (10.6 minutes!)

Current query has complex OR conditions that prevent index usage:
```sql
WHERE (
    ingestion = 'Pending'::"ImageIngestionStatus"
    AND ("scanRequestedAt" IS NULL OR "scanRequestedAt" <= now() - interval)
  ) OR (
    ingestion = 'Error'::"ImageIngestionStatus"
    AND "scanRequestedAt" <= now() - interval
    AND ("scanJobs"->>'retryCount')::int < limit
  )
```

**Optimization Strategy:**
- Split into two separate queries (one for Pending, one for Error)
- Add partial indexes for each condition
- Process results separately then combine

## Recommended Refactoring Pattern

For all metric queries, apply this pattern:

```typescript
// Before: Direct INSERT with complex SELECT
await executeRefresh(ctx)`
  INSERT INTO "SomeMetric" (...)
  SELECT /* complex aggregation */
  FROM "SourceTable"
  CROSS JOIN timeframes
  WHERE id IN (${ids})
  GROUP BY ...
  ON CONFLICT (...) DO UPDATE ...
`;

// After: Two-phase approach
const metrics = await ctx.db.$queryRaw<{ data: any }[]>`
  WITH metric_data AS (
    SELECT /* complex aggregation */
    FROM "SourceTable"
    CROSS JOIN timeframes
    WHERE id IN (${ids})
    GROUP BY ...
  )
  SELECT jsonb_agg(jsonb_build_object(...)) as data
  FROM metric_data
`;

if (metrics?.[0]?.data) {
  await executeRefresh(ctx)`
    INSERT INTO "SomeMetric" (...)
    SELECT /* simple extraction from JSON */
    FROM jsonb_array_elements(${metrics[0].data}::jsonb)
    ON CONFLICT (...) DO UPDATE ...
  `;
}
```

## Priority Recommendations

### Immediate (Next Sprint)
1. **Image Resource Bulk Insert** - Currently taking 11.5 minutes average
2. **Image Ingestion Query** - Currently taking 10.6 minutes average
3. **Tag Metrics** - Similar pattern to already-fixed queries

### Short-term (2-4 weeks)
1. All remaining metric files (article, bounty, club, etc.)
2. Post image reactions query optimization
3. Review and optimize any other CROSS JOIN patterns

### Long-term Considerations
1. **Metric Processing Architecture**
   - Consider moving all metrics to a separate read replica
   - Implement async metric processing with queues
   - Use materialized views for frequently accessed aggregations

2. **Batch Processing Improvements**
   - Dynamic batch sizing based on data volume
   - Parallel processing where possible
   - Circuit breakers for long-running queries

3. **Database Optimizations**
   - Add missing indexes (especially partial indexes)
   - Regular VACUUM and ANALYZE scheduling
   - Consider partitioning large tables

## Index Recommendations

Add these indexes to improve query performance:

```sql
-- For Image ingestion queries
CREATE INDEX idx_image_ingestion_pending 
  ON "Image" ("ingestion", "scanRequestedAt") 
  WHERE ingestion = 'Pending';

CREATE INDEX idx_image_ingestion_error 
  ON "Image" ("ingestion", "scanRequestedAt", ("scanJobs"->>'retryCount')) 
  WHERE ingestion = 'Error';

-- For ImageResourceNew bulk inserts
CREATE INDEX idx_image_resource_conflict 
  ON "ImageResourceNew" ("imageId", "modelVersionId");

-- For tag metrics
CREATE INDEX idx_tag_engagement_target 
  ON "TagEngagement" ("tagId", "createdAt");
```

## Monitoring Recommendations

1. Set up alerts for queries exceeding 30 seconds
2. Track metric update job durations
3. Monitor lock wait times during bulk operations
4. Regular review of PgHero slow query reports
5. Implement query performance regression tests

## Expected Impact

By applying these optimizations:
- Reduce average query time by 90-95%
- Eliminate database blocking during metric updates
- Improve overall application responsiveness
- Reduce WAL growth and autovacuum pressure

---
*Date: 2025-08-13*
*Analysis based on PgHero slow query report and codebase review*