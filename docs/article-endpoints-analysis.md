# Article Endpoints Analysis - getScanStatus vs getArticleById

**Date**: 2025-10-10
**Context**: After implementing contentImages in getArticleById, evaluate if getScanStatus is still needed

## Question

Now that `getArticleById` returns `contentImages` with ingestion status, do we still need a separate `getScanStatus` endpoint?

## Current State

### getArticleById Endpoint

**Returns** (~5-50KB response):
```typescript
{
  id: number;
  title: string;
  content: string; // Large HTML/JSON
  coverImage: {...};
  user: {...};
  tags: [...];
  stats: {...};
  contentImages: Array<{
    id: number;
    url: string;
    ingestion: ImageIngestionStatus;
  }>;
  // ... many other fields
}
```

**Use Case**: Load full article data for editing/viewing

### getScanStatus Endpoint

**Returns** (~100 bytes response):
```typescript
{
  total: number;
  scanned: number;
  blocked: number;
  error: number;
  pending: number;
  allComplete: boolean;
}
```

**Use Case**: Lightweight polling for real-time scan progress

## Usage Comparison

| Aspect | getArticleById | getScanStatus |
|--------|---------------|---------------|
| **Response Size** | 5-50KB | ~100 bytes |
| **Call Frequency** | Once on page load | Every 15 seconds while scanning |
| **Purpose** | Full article data | Scan progress only |
| **Used By** | Article editor/viewer | ArticleScanStatus component |
| **Data Overhead** | High (full article) | Minimal (6 numbers) |

## Use Case Analysis

### 1. Modal Decision (At Publish Time)

**Scenario**: User clicks "Publish" button

**Current Solution** ✅:
```typescript
// Uses getArticleById.contentImages (already loaded)
const existingUrls = new Set(article?.contentImages?.map(img => img.url) || []);
const newImages = contentImages.filter(img => !existingUrls.has(img.url));

if (newImages.length === 0) {
  submitArticle(); // Skip modal
}
```

**Endpoint Used**: `getArticleById` (already loaded when page opened)
**Frequency**: Once per publish attempt
**Verdict**: ✅ **No need for getScanStatus here**

---

### 2. Real-Time Progress Display

**Scenario**: Article is in "Processing" status, showing scan progress

**Current Solution** ✅:
```typescript
// ArticleScanStatus component
const { status } = useArticleScanStatus({ articleId, enabled: true });
// Polls getScanStatus every 15 seconds

return (
  <Progress value={(status.scanned / status.total) * 100} />
  <Text>{status.scanned} of {status.total} scanned</Text>
);
```

**Could We Use getArticleById Instead?** ❌

```typescript
// Alternative with getArticleById
const { data: article } = trpc.article.getById.useQuery(
  { id: articleId },
  { refetchInterval: 15000 } // Poll every 15s
);

// Calculate on client
const scanStatus = useMemo(() => {
  const images = article?.contentImages || [];
  return {
    total: images.length,
    scanned: images.filter(i => i.ingestion === 'Scanned').length,
    // ...
  };
}, [article?.contentImages]);
```

**Problems with this approach**:
- ❌ Downloads 5-50KB every 15 seconds (vs 100 bytes)
- ❌ Transfers full article content repeatedly
- ❌ Causes unnecessary React Query cache updates
- ❌ Re-renders unrelated components
- ❌ Wastes bandwidth (~99% overhead)

**Endpoint Used**: `getScanStatus` (lightweight polling)
**Frequency**: Every 15 seconds for 30-60 seconds
**Verdict**: ✅ **getScanStatus is essential here**

---

## Performance Impact Comparison

### Scenario: Article with 10 images, 60-second scan time

**With getScanStatus** (Current) ✅:
```
Polls: 4 requests @ 100 bytes each
Total: 400 bytes
Cache: Minimal updates (status object only)
```

**With getArticleById Polling** ❌:
```
Polls: 4 requests @ 25KB each
Total: 100KB (250x more data!)
Cache: Full article re-cached 4 times
Overhead: Content, stats, user data re-transferred
```

## Recommendation: Keep Both Endpoints

### Reasons to Keep getScanStatus

1. **Performance** ⚡
   - 99% smaller response size (100 bytes vs 5-50KB)
   - Optimized for high-frequency polling
   - Minimal bandwidth usage

2. **Separation of Concerns** 🎯
   - Clear API design: status endpoint vs data endpoint
   - Purpose-built for progress tracking
   - Returns pre-calculated aggregates

3. **Cache Efficiency** 💾
   - Doesn't pollute React Query cache with repeated full articles
   - Status updates don't trigger article data re-renders
   - Independent cache invalidation strategies

4. **User Experience** 👤
   - Faster updates (smaller payloads)
   - Lower data usage for mobile users
   - Better performance on slow connections

### Optimization Opportunity: Shared Helper Function

While keeping both endpoints, we can reduce code duplication:

```typescript
// src/server/services/article.service.ts

/**
 * Shared helper: Fetch article's connected images
 */
async function fetchArticleImages(articleId: number) {
  return await dbRead.imageConnection.findMany({
    where: {
      entityId: articleId,
      entityType: 'Article',
    },
    include: {
      image: {
        select: {
          id: true,
          url: true,
          ingestion: true,
        },
      },
    },
  });
}

// Used in getArticleById
export const getArticleById = async ({ id, ... }) => {
  // ...
  const imageConnections = await fetchArticleImages(id);

  return {
    ...article,
    contentImages: imageConnections.map((conn) => conn.image),
  };
};

// Used in getScanStatus
export async function getArticleScanStatus({ id }: GetByIdInput) {
  const imageConnections = await fetchArticleImages(id);
  const images = imageConnections.map((conn) => conn.image);

  const total = images.length;
  const scanned = images.filter((i) => i.ingestion === 'Scanned').length;
  const blocked = images.filter((i) => i.ingestion === 'Blocked').length;
  const error = images.filter((i) => ['Error', 'NotFound'].includes(i.ingestion)).length;
  const pending = total - scanned - blocked - error;

  return {
    total,
    scanned,
    blocked,
    error,
    pending,
    allComplete: pending === 0,
  };
}
```

**Benefits**:
- ✅ Eliminates query duplication
- ✅ Ensures consistency between endpoints
- ✅ Easier maintenance (single source of truth)
- ✅ Both endpoints remain optimized for their use case

## Alternative: When to Consolidate Endpoints

Consolidation would make sense if:

❌ **Not our case**: Both endpoints returned similar data sizes
❌ **Not our case**: Polling frequency was very low (once per minute)
❌ **Not our case**: Bandwidth wasn't a concern
❌ **Not our case**: We used WebSocket for real-time updates instead

✅ **Our case**: High-frequency polling with vastly different data needs

## Conclusion

### Final Recommendation: Keep Both + Add Shared Helper

**Keep getScanStatus** because:
1. Optimized for real-time polling (99% smaller response)
2. Purpose-built for progress tracking
3. Better performance and user experience
4. Clear API design with separation of concerns

**Keep getArticleById with contentImages** because:
1. Provides data for modal decision (no extra query)
2. One-time load, not used for polling
3. Returns full article context needed for editing

**Add shared helper function** to:
1. Eliminate code duplication
2. Ensure consistency
3. Simplify maintenance

## Implementation Plan

### Optional Enhancement: Shared Helper Function

If you want to reduce duplication, add this helper:

```typescript
// src/server/services/article.service.ts

/**
 * Fetch article's connected images with ingestion status
 * Shared by getArticleById and getScanStatus
 */
async function fetchArticleImages(articleId: number) {
  return await dbRead.imageConnection.findMany({
    where: {
      entityId: articleId,
      entityType: 'Article',
    },
    include: {
      image: {
        select: {
          id: true,
          url: true,
          ingestion: true,
        },
      },
    },
  });
}
```

Then update both functions to use it. This is **optional but recommended** for cleaner code.

## Related Files

- [article.service.ts](../src/server/services/article.service.ts) - Contains both endpoints
- [article.router.ts](../src/server/routers/article.router.ts) - Exposes both endpoints
- [useArticleScanStatus.ts](../src/hooks/useArticleScanStatus.ts) - Uses getScanStatus for polling
- [ArticleScanStatus.tsx](../src/components/Article/ArticleScanStatus.tsx) - Real-time progress UI

---

**Analysis Date**: 2025-10-10
**Recommendation**: ✅ **Keep both endpoints, optionally add shared helper**
**Rationale**: Performance, separation of concerns, optimal user experience
