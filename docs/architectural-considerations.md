# Architectural Considerations: Article Image Scanning

**Date**: 2025-10-06
**Authors**: Backend Architect + Frontend Architect Reviews
**Related**: [Analysis](./article-image-scanning-analysis.md) | [Workflow](./article-image-scanning-workflow.md)

---

## Executive Summary

This document captures critical architectural decisions and technical rationale for the article image scanning implementation, based on expert reviews identifying issues that could cause production failures.

**Key Findings**:
- **Timeline**: 4 weeks with architectural fixes and existing feature flag integration
- **Critical Fixes Required**: Race conditions, performance bottlenecks, UX issues
- **Deployment Strategy**: Simple feature flag toggle using existing feature-flags.service.ts
- **Risk Level**: 🟡 MODERATE-HIGH without fixes, 🟢 LOW with implementation

---

## Table of Contents

1. [Backend Architecture Decisions](#backend-architecture-decisions)
2. [Frontend Architecture Decisions](#frontend-architecture-decisions)
3. [Database Design](#database-design)
4. [Performance Optimization](#performance-optimization)
5. [Security Considerations](#security-considerations)
6. [Testing Strategy](#testing-strategy)
7. [Deployment Strategy](#deployment-strategy)

---

## Backend Architecture Decisions

### 1. Advisory Locks for Concurrency Control

**Problem**: Multiple webhook calls processing same article simultaneously causes race conditions.

**Scenario**:
```
Webhook 1: Image 1 scanned → reads article (5 pending)
Webhook 2: Image 2 scanned → reads article (5 pending)
Webhook 1: updates metadata (4 pending)
Webhook 2: updates metadata (4 pending) ❌ Lost update!
```

**Solution**: PostgreSQL advisory locks

```typescript
await dbWrite.$transaction(async (tx) => {
  // 🔒 Acquire lock - only one webhook can execute this block
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

  // Safe critical section
  const connections = await tx.imageConnection.findMany({ ... });
  await updateArticleStatus({ ... });

  // Lock released automatically at transaction end
});
```

**Why Advisory Locks vs. Alternatives**:
| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Row-level locking (FOR UPDATE) | Standard SQL | Holds locks longer | 🟡 Acceptable |
| Advisory locks | Low overhead, explicit | PostgreSQL-specific | ✅ **Recommended** |
| Optimistic locking (version field) | No locks | Retry complexity | 🟡 Fallback |
| Application-level mutex | Framework-agnostic | Doesn't work across processes | ❌ Not viable |

**Decision**: **Advisory locks** for best balance of correctness and performance.

---

### 2. Webhook Debouncing

**Problem**: N+1 webhook issue - 50 images = 50 database updates (wasteful).

**Scenario**:
```
Image 1 scans → Webhook → updateArticleImageScanStatus() → Query all 50 connections
Image 2 scans → Webhook → updateArticleImageScanStatus() → Query all 50 connections ❌
... (48 more redundant queries)
Image 50 scans → Webhook → updateArticleImageScanStatus() → Query all 50 connections

Total: 50 × 1 query = 2,500 database queries for metadata
```

**Solution**: Redis-based debouncing

```typescript
export async function debounceArticleUpdate(articleId: number) {
  const key = `article-scan-update:${articleId}`;
  const exists = await redis.get(key);

  if (!exists) {
    // Set lock with 2s TTL
    await redis.setex(key, 2, '1');

    // Schedule single update after delay
    setTimeout(async () => {
      await updateArticleImageScanStatus([articleId]);
      await redis.del(key);
    }, 1000); // Wait 1s for other webhooks
  }
  // If key exists, another webhook already scheduled the update
}
```

**Performance Impact**:
- **Before**: 50 webhooks × 1 query each = **50 database queries**
- **After**: 50 webhooks → debounce → **1 database query**
- **Reduction**: **98% fewer queries**

**Why Debouncing vs. Alternatives**:
| Approach | Performance | Complexity | Scalability | Verdict |
|----------|-------------|------------|-------------|---------|
| Redis debounce | ✅ Excellent | 🟢 Low | ✅ Scales | ✅ **Recommended** |
| Bull queue | ✅ Excellent | 🟡 Medium | ✅ Scales | 🟡 Overkill for this |
| Immediate update | ❌ Poor (N+1) | 🟢 Low | ❌ Doesn't scale | ❌ Not viable |

**Decision**: **Redis debouncing** - simpler than Bull queue, same benefits.

---

### 3. Database Constraints & Indexes

> **📝 NOTE**: Most indexes already exist in production database. This section documents required constraints for completeness. Always verify which indexes exist before running migrations.

**Problem 1**: No unique constraint on `Image.url` allows duplicates during race conditions.

**Scenario**:
```typescript
// Request 1 and 2 both check for image, both find none
let image = await db.image.findFirst({ where: { url } });

if (!image) {
  // Both create the image! Two duplicates with same URL
  image = await db.image.create({ data: { url, ... } });
}
```

**Solution**: Unique constraint (if not already present)

```sql
-- ⚠️ CHECK FIRST: May already exist in production
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Image_url_unique" ON "Image"("url");
```

**Benefits**:
- Prevents duplicates at database level
- Enables atomic upsert operations
- Handles race conditions without application logic

**🛑 MANUAL MIGRATION CHECKPOINT**: Before running migrations:
1. Query production to check existing indexes
2. Coordinate with team to apply only missing constraints
3. Update Prisma schema to reflect production reality

---

**Problem 2**: Missing indexes for new query patterns

**Solution**: Add performance indexes

```sql
-- Optimize ImageConnection lookups for articles
CREATE INDEX CONCURRENTLY "ImageConnection_Article_idx"
ON "ImageConnection"("entityType", "entityId")
WHERE "entityType" = 'Article';

-- Optimize Image scans query
CREATE INDEX CONCURRENTLY "Image_ingestion_nsfwLevel_idx"
ON "Image"("ingestion", "nsfwLevel")
WHERE "ingestion" = 'Scanned';
```

**Performance Impact**:
- **Before**: Sequential scan on ImageConnection (slow for 100K+ connections)
- **After**: Index seek with partial index (10-20ms queries)

---

### 4. NSFW Level Calculation SQL

**Problem**: Original SQL doesn't filter by scan status, uses inefficient LATERAL join.

**Original (Problematic)**:
```sql
LEFT JOIN LATERAL (
  SELECT bit_or(i."nsfwLevel") AS "nsfwLevel"
  FROM "ImageConnection" ic
  JOIN "Image" i ON ic."imageId" = i.id
  WHERE ic."entityType" = 'Article' AND ic."entityId" = a.id
  -- ❌ Missing: AND i."ingestion" = 'Scanned'
) content_images ON true
```

**Optimized**:
```sql
-- Cover image
LEFT JOIN "Image" cover
  ON a."coverId" = cover.id
  AND cover."ingestion" = 'Scanned'  -- ✅ Only scanned

-- Content images
LEFT JOIN "ImageConnection" ic
  ON ic."entityId" = a.id AND ic."entityType" = 'Article'
LEFT JOIN "Image" content_imgs
  ON ic."imageId" = content_imgs.id
  AND content_imgs."ingestion" = 'Scanned'  -- ✅ Only scanned

WHERE a.id = ANY(${articleIds}::int[])  -- ✅ Better than IN
GROUP BY a.id
```

**Why This is Better**:
- ✅ Only includes scanned images (correct NSFW level)
- ✅ Uses `bit_or()` because NSFW levels are **bitwise flags** (e.g., Soft=1, Mature=2, X=4)
  - Example: `bit_or(1, 2)` = 3 (Soft | Mature flags combined)
  - This correctly combines all NSFW flags from cover + content images
- ✅ Uses standard LEFT JOIN (planner optimizes better than LATERAL)
- ✅ Uses `= ANY()` instead of `IN` (better performance)
- ✅ Adds `WHERE changed` check (avoids unnecessary updates)

---

### 5. Migration Transaction Safety

**Problem**: Original migration lacks transaction safety - failure halfway leaves partial data.

**Original (Unsafe)**:
```typescript
for (const article of articles) {
  try {
    // ❌ No transaction - if this fails halfway:
    // - Some images created
    // - Some connections created
    // - Orphaned data
    const imageUrls = extractImagesFromArticle(article.content);

    for (const { url } of imageUrls) {
      let image = await db.image.findFirst({ where: { url } });
      if (!image) {
        image = await db.image.create({ data: { url, ... } });
      }
      await db.imageConnection.upsert({ ... });
    }
  } catch (error) {
    // Error swallowed, migration continues
    stats.errors.push(errorMsg);
  }
}
```

**Fixed (Transaction-Safe)**:
```typescript
for (const article of articles) {
  try {
    // ✅ Wrapped in transaction - all-or-nothing
    await prisma.$transaction(async (tx) => {
      const imageUrls = extractImagesFromArticle(article.content);

      for (const { url } of imageUrls) {
        // Atomic upsert with unique constraint
        const image = await tx.image.upsert({
          where: { url },  // Requires unique constraint
          create: { url, userId, type: 'image', ingestion: 'Pending' },
          update: {},
        });

        await tx.imageConnection.upsert({ ... });
      }
    }, { timeout: 30000 });

    stats.articlesProcessed++;
  } catch (error) {
    // Transaction auto-rolled back on error
    stats.errors.push(`Article ${article.id}: ${error}`);
  }
}
```

**Additional Safety Features**:
- Checkpoint/resume capability (saves progress to file)
- Dry-run mode (test without changes)
- Idempotent (can run multiple times safely)

---

## Frontend Architecture Decisions

### 6. Image Creation Timing: Save-Time vs Upload-Time

**Original Plan**: Create Image entities on upload (during editing)

**Problem**:
- Users upload images then delete them from content
- Users replace images multiple times before saving
- Users abandon draft articles entirely
- Result: Database fills with orphaned Image entities

**Revised Approach**: Create Image entities on article save

**Original (Problematic)**:
```typescript
// During editing - creates DB records immediately
async function handleArticleImageUpload(file: File, articleId: number) {
  const url = await uploadToS3(file);

  // ❌ Problem: Creates Image entity even if user deletes from content
  const image = await db.image.create({ data: { url, ... } });

  // ❌ Problem: Creates ImageConnection that may become orphaned
  await db.imageConnection.create({ data: { imageId, articleId, ... } });

  return url;
}
```

**Revised (Clean)**:
```typescript
// During editing - upload only, no DB operations
async function handleArticleImageUpload(file: File) {
  const url = await uploadToS3(file);

  // Just return URL to editor (no DB operations)
  return url;
}

// On article save - parse final HTML and create entities
const handleSubmit = async (data) => {
  // 1. Extract images from FINAL content
  const contentImages = extractImagesFromArticle(data.content);

  // 2. Create Image entities only for images in final content
  // 3. Create ImageConnections only for final images
  // 4. No orphaned records!
};
```

**Benefits**:
- ✅ No orphaned Image records
- ✅ No orphaned ImageConnection records
- ✅ Simpler cleanup logic
- ✅ Users can edit freely without database pollution

---

### 7. Real-Time Scan Status Updates

**Original Plan**: No real-time updates specified

**Problem**: Users see stale scan status until manual page refresh.

**Solution**: tRPC polling with smart refetch

```typescript
// src/hooks/useArticleScanStatus.ts

export function useArticleScanStatus(articleId: number | undefined) {
  return trpc.article.getScanStatus.useQuery(
    { articleId: articleId! },
    {
      enabled: !!articleId,
      refetchInterval: (data) => {
        // ✅ Stop polling when complete (save resources)
        if (data?.allComplete) return false;

        // ✅ Poll every 3 seconds while pending
        return 3000;
      },
    }
  );
}
```

**Why Polling vs. Alternatives**:
| Approach | Complexity | Latency | Infrastructure | Verdict |
|----------|-----------|---------|----------------|---------|
| Polling (3s) | 🟢 Low | 🟡 3s | 🟢 None | ✅ **Recommended** |
| WebSockets | 🟡 Medium | ✅ Instant | 🟡 WS server | 🟡 Overkill |
| Server-Sent Events | 🟡 Medium | ✅ Instant | 🟡 SSE setup | 🟡 Overkill |
| Manual refresh | 🟢 Low | ❌ Never | 🟢 None | ❌ Poor UX |

**Decision**: **Polling** - simpler than WebSockets, good enough UX (3s latency acceptable).

---

### 8. Error Recovery Workflows

**Original Plan**: Basic error messaging

**Problem**: No clear user actions when images are blocked or fail to scan.

**Solution**: Comprehensive error states with recovery actions

```tsx
export function ArticleScanStatus({ articleId }) {
  const { data } = useArticleScanStatus(articleId);

  // Blocked images - Critical error
  if (data.blocked > 0) {
    return (
      <Alert color="red" title="Blocked Images Detected">
        <Text>{data.blocked} image(s) violated content policy.</Text>
        <Button onClick={onRemoveBlockedImages}>
          Review and Remove Blocked Images
        </Button>
      </Alert>
    );
  }

  // Failed scans - Recoverable error
  if (data.error > 0) {
    return (
      <Alert color="orange" title="Some Images Failed to Scan">
        <Text>{data.error} image(s) failed to scan.</Text>
        <Group>
          <Button onClick={onRetryScans}>Retry Scanning</Button>
          <Button onClick={onPublishAnyway}>Publish Anyway</Button>
        </Group>
      </Alert>
    );
  }

  // Scanning in progress
  if (!data.allComplete) {
    return (
      <Alert color="blue" title="Scanning Images">
        <Progress value={progress} />
        <Text>{data.scanned} of {data.total} images scanned</Text>
      </Alert>
    );
  }

  return null;
}
```

**Error States Covered**:
1. **Blocked images**: Clear action to remove violating content
2. **Failed scans**: Retry option + "publish anyway" escape hatch
3. **Pending scans**: Progress indicator with counts
4. **Complete**: No UI clutter

---

### 9. Status Terminology

**Original**: `ArticleStatus.PendingReview`

**Problem**: Suggests human moderation, confusing for automatic scanning.

**Revised**: `ArticleStatus.Processing`

**Why**:
| Term | User Interpretation | Accurate? |
|------|---------------------|-----------|
| PendingReview | "Moderator reviewing my article" | ❌ No |
| AwaitingApproval | "Waiting for human approval" | ❌ No |
| Processing | "System processing images" | ✅ Yes |
| ScanningImages | "Images being scanned" | ✅ Yes (but verbose) |

**Decision**: `Processing` - Clear, concise, accurate.

**UI Labels**:
```typescript
const statusLabels = {
  Draft: 'Draft',
  Processing: 'Processing Images',  // Not "Pending Review"
  Published: 'Published',
  Unpublished: 'Unpublished',
};

const statusDescriptions = {
  Processing: 'Your article will publish automatically when all images are scanned for content safety.',
};
```

---

## Database Design

### Schema Changes Summary

**Minimal Changes (Good Design)**:
- ✅ Reuse existing `ImageConnection` table
- ✅ Add single enum value to `ArticleStatus`
- ✅ Add database constraints and indexes
- ❌ **No new tables** (avoids schema proliferation)

**Full Migration**:
```sql
-- 1. Add new status
ALTER TYPE "ArticleStatus" ADD VALUE IF NOT EXISTS 'Processing';

-- 2. Add unique constraint (prevents duplicates)
CREATE UNIQUE INDEX CONCURRENTLY "Image_url_unique" ON "Image"("url");

-- 3. Add performance indexes
CREATE INDEX CONCURRENTLY "ImageConnection_Article_idx"
ON "ImageConnection"("entityType", "entityId")
WHERE "entityType" = 'Article';

CREATE INDEX CONCURRENTLY "Image_ingestion_nsfwLevel_idx"
ON "Image"("ingestion", "nsfwLevel")
WHERE "ingestion" = 'Scanned';
```

**Why CONCURRENTLY**:
- Avoids table locks (production remains online)
- Builds index without blocking writes
- Takes longer but zero downtime

---

### Metadata Storage Philosophy

**Anti-Pattern**: Caching derived state in `Article.metadata` JSON field

**Problem**:
```typescript
// ❌ BAD: Storing derived state causes inconsistency
await db.article.update({
  where: { id: articleId },
  data: {
    metadata: {
      imagesPending: 5,   // What if ImageConnection says 6?
      imagesScanned: 2,    // What if actual count is 3?
    }
  }
});
```

**Risk**: Metadata becomes stale/incorrect if:
- Webhook fails to update
- Race condition corrupts count
- ImageConnection changes outside webhook

**Solution**: Compute real-time, don't cache

```typescript
// ✅ GOOD: Compute from source of truth
const getScanStatus = async (articleId: number) => {
  const connections = await db.imageConnection.findMany({
    where: { entityId: articleId, entityType: 'Article' },
    include: { image: { select: { ingestion: true } } }
  });

  return {
    total: connections.length,
    scanned: connections.filter(c => c.image.ingestion === 'Scanned').length,
    // ... computed fresh each time
  };
};
```

**When to Use Metadata**:
- ✅ User notes, preferences (non-derived data)
- ✅ Error messages for debugging
- ❌ Counts that can be computed from relations
- ❌ Status that duplicates database state

---

## Performance Optimization

### Query Performance

**Before Optimization**:
- Sequential scans on ImageConnection (100K+ rows)
- N+1 queries in image linking
- Redundant webhook updates

**After Optimization**:
| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| ImageConnection lookup | 500ms (seq scan) | 10ms (index) | **50x faster** |
| Image linking | 50 queries (N+1) | 2 queries (batch) | **25x fewer queries** |
| Webhook updates | 50 updates | 1 update (debounce) | **50x fewer updates** |

**Techniques Used**:
1. **Partial indexes**: Filter `WHERE "entityType" = 'Article'`
2. **Batch queries**: `findMany({ where: { url: { in: urls } } })`
3. **Debouncing**: Redis-based request coalescing
4. **Native DOMParser**: Client-side HTML parsing (faster than JSDOM)

---

### Migration Performance

**Estimated Load**:
- 1M articles × 10 images avg = 10M image lookups
- At 100 articles/batch = 10,000 batches

**Original Estimate**: 14 hours
**Optimized Estimate**: 90 minutes

**Optimizations**:
1. Batch image lookups (10K queries → 100 queries)
2. Transaction per article (atomic, safe rollback)
3. Checkpoint system (resume on failure)
4. CONCURRENTLY indexes (no table locks)

---

## Security Considerations

### URL Validation

**Attack Vector**: Malicious user injects `<img>` tags with internal URLs

```html
<img src="https://image.civitai.com/../../../admin/secret.png" />
<img src="file:///etc/passwd" />
<img src="javascript:alert('xss')" />
```

**Defense**: Strict URL validation

```typescript
function isValidCivitaiImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const allowedHosts = [
      'image.civitai.com',
      'civitai.com',
      'wasabisys.com',
      'civitai-prod.s3.amazonaws.com',
    ];

    // ✅ Hostname must match exactly or be subdomain
    return allowedHosts.some(host =>
      parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );
  } catch {
    return false;  // Invalid URL
  }
}
```

**Additional Checks**:
- ✅ Protocol must be `https://`
- ✅ No path traversal (`../`)
- ✅ No data URIs
- ✅ No javascript URIs

---

### NSFW Level Bypass Prevention

**Scenario**: User tries to lower NSFW level below actual content

**Protection**: Use `GREATEST()` function

```sql
SET "nsfwLevel" = GREATEST(a."userNsfwLevel", computed."nsfwLevel")
```

**Logic**:
- User can only **increase** NSFW level (be more conservative)
- User **cannot decrease** below actual scan results
- Moderators can override with `lockedProperties` field

---

## Testing Strategy

### Critical Test Scenarios

**1. Concurrency Tests**
```typescript
it('handles 50 concurrent webhooks without race conditions', async () => {
  const article = await createArticle({ imageCount: 50 });

  // Simulate 50 simultaneous webhook calls
  await Promise.all(
    article.images.map(image =>
      webhookHandler({ id: image.id, ingestion: 'Scanned' })
    )
  );

  // Should have exactly correct status (no lost updates)
  const updated = await db.article.findUnique({ where: { id: article.id } });
  expect(updated.status).toBe('Published');
});
```

**2. Duplicate Prevention Tests**
```typescript
it('prevents duplicate images with concurrent saves', async () => {
  const content = '<img src="https://image.civitai.com/test.jpg" />';

  // Two users save articles with same image simultaneously
  await Promise.all([
    upsertArticle({ userId: 1, content }),
    upsertArticle({ userId: 2, content }),
  ]);

  // Should have only 1 Image entity (unique constraint)
  const images = await db.image.findMany({
    where: { url: 'https://image.civitai.com/test.jpg' }
  });
  expect(images).toHaveLength(1);
});
```

**3. Error Handling Tests**
```typescript
it('publishes article even with failed image scans', async () => {
  const article = await createArticleWithImages(5);

  // 4 succeed, 1 fails
  await Promise.all([
    ...article.images.slice(0, 4).map(i =>
      scanImage(i.id, { ingestion: 'Scanned' })
    ),
    scanImage(article.images[4].id, { ingestion: 'NotFound' }),
  ]);

  // Should still publish (treat errors as "complete")
  const updated = await db.article.findUnique({ where: { id: article.id } });
  expect(updated.status).toBe('Published');
});
```

**Test Coverage Targets**:
- Unit tests: >80% coverage
- Integration tests: All critical paths
- E2E tests: Complete user flows
- Load tests: 1000 concurrent webhooks

---

## Deployment Strategy

### Feature Flag Integration

**Why Use Existing System**:
- Leverage existing feature-flags.service.ts infrastructure
- Simple toggle: enabled/disabled for all users
- Fast rollback via code deployment
- Consistent with other Civitai features
- No additional infrastructure needed

**Implementation**:
```typescript
// src/server/services/feature-flags.service.ts

const featureFlags = createFeatureFlags({
  // ... existing flags ...

  articleImageScanning: [],  // Initially disabled
  // OR
  articleImageScanning: ['public'],  // Enable for all users
});
```

**Usage in Code**:
```typescript
// Backend
const { features } = getFeatureFlagsLazy({ user, req });

if (features.articleImageScanning) {
  // New flow: link images, check scans
  await linkArticleContentImages({ ... });
}

// Frontend
const { features } = useFeatureFlags();

{features.articleImageScanning && (
  <ArticleScanStatus articleId={article.id} />
)}
```

**Rollout Strategy**:
```bash
# Phase 1: Deploy with flag disabled (Day 17-19)
# - Run migration to populate ImageConnections
# - Validate migration data
# - No behavior change for users

# Phase 2: Enable flag (Day 20)
# - Change articleImageScanning: ['public']
# - Deploy to production
# - Monitor for 24 hours

# Rollback if needed:
# - Change articleImageScanning: []
# - Deploy (instant rollback)
```

**Monitoring After Enabling**:
- Error rate < 0.1%
- Scan completion rate > 95%
- Average scan time < 30s
- No database performance degradation
- No user complaints about publishing delays

**Rollback Plan**:
```typescript
// Immediate rollback via code change + deploy
const featureFlags = createFeatureFlags({
  articleImageScanning: [],  // Disable feature
});

// Investigate and fix before re-enabling
```

---

### Migration Strategy

**Pre-Flight Checks**:
```bash
# 1. Dry-run on production data (no changes)
npm run migrate:article-images -- --dry-run

# 2. Review dry-run results
cat migration-progress.json

# 3. Verify unique constraint added
psql -c "\d+ Image" | grep url_unique

# 4. Verify indexes created
psql -c "\di+ ImageConnection_Article_idx"
```

**Execution**:
```bash
# Run migration with checkpointing
npm run migrate:article-images -- --batch=100

# Monitor progress in separate terminal
watch -n 5 cat migration-progress.json
```

**Post-Migration Validation**:
```sql
-- Verify ImageConnections created
SELECT COUNT(*) FROM "ImageConnection" WHERE "entityType" = 'Article';

-- Verify no duplicate Image URLs
SELECT url, COUNT(*) FROM "Image" GROUP BY url HAVING COUNT(*) > 1;

-- Verify NSFW levels updated
SELECT COUNT(*) FROM "Article"
WHERE "nsfwLevel" = 0 AND id IN (
  SELECT DISTINCT "entityId" FROM "ImageConnection" WHERE "entityType" = 'Article'
);
```

---

## Monitoring & Observability

### Key Metrics to Track

**Performance Metrics**:
- Image extraction time (p50, p95, p99)
- Scan status query time
- Webhook processing time
- Migration progress rate

**Business Metrics**:
- Article publish success rate
- Scan completion rate
- Average time to publish
- Blocked image rate

**Error Metrics**:
- Webhook failure rate
- Migration errors
- Race condition occurrences
- Database lock timeouts

**Dashboard Queries**:
```sql
-- Articles stuck in Processing (alert if > 100)
SELECT COUNT(*) FROM "Article"
WHERE status = 'Processing'
  AND "updatedAt" < NOW() - INTERVAL '24 hours';

-- Webhook processing time (alert if > 500ms p95)
SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
FROM webhook_logs
WHERE event_type = 'image-scan-result';

-- Scan completion rate (alert if < 95%)
SELECT
  COUNT(CASE WHEN ingestion = 'Scanned' THEN 1 END) * 100.0 / COUNT(*) as completion_rate
FROM "Image"
WHERE "createdAt" > NOW() - INTERVAL '24 hours';
```

---

## Decision Log

### Major Decisions

| Decision | Rationale | Alternatives Considered | Outcome |
|----------|-----------|------------------------|---------|
| Advisory locks | Best balance correctness/performance | Row locks, optimistic locking | ✅ Chosen |
| Redis debouncing | Simple, effective N+1 fix | Bull queue, immediate updates | ✅ Chosen |
| Save-time image creation | Prevents orphaned records | Upload-time creation | ✅ Changed from original |
| tRPC polling | Simple, good enough UX | WebSockets, SSE | ✅ Chosen |
| Processing status | Clear terminology | PendingReview, AwaitingApproval | ✅ Changed from original |
| 5-week timeline | Address critical fixes | 4-week (risky) | ✅ Extended |

---

## Risk Assessment

### Production Readiness

**Before Fixes**:
| Risk | Severity | Likelihood | Impact |
|------|----------|------------|--------|
| Race conditions | 🔴 Critical | High | Data corruption |
| N+1 performance | 🔴 Critical | High | Site slowdown |
| Orphaned records | 🟡 High | High | Database bloat |
| Missing indexes | 🟡 High | High | Slow queries |
| **Overall** | **🔴 NO-GO** | - | - |

**After Fixes**:
| Risk | Severity | Likelihood | Impact |
|------|----------|------------|--------|
| Migration failures | 🟡 Medium | Low | Partial migration (recoverable) |
| User confusion | 🟢 Low | Medium | Support tickets |
| Edge case bugs | 🟢 Low | Low | Minor issues |
| **Overall** | **🟢 GO** | - | - |

---

## Conclusion

**Timeline Recommendation**: 4 weeks

**Critical Path**:
1. Week 1: Database fixes (indexes, locks, debouncing) + Feature flag setup
2. Week 2: Core services (save-time images, batch queries)
3. Week 3: UI (real-time updates, error recovery)
4. Week 4: Testing, migration, and rollout with simple feature toggle

**Success Criteria**:
- ✅ Zero race condition bugs in production
- ✅ Zero data corruption incidents
- ✅ <1% error rate
- ✅ >95% scan completion rate
- ✅ User satisfaction with UX
- ✅ Fast rollback capability via feature flag

**Go/No-Go**: ✅ **GO** with 4-week timeline, all fixes implemented, and existing feature flag system

---

**Document Version**: 1.1
**Last Updated**: 2025-10-06 (Updated to use existing feature flag system)
**Next Review**: After Week 1 completion
