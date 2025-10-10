# Article Image Scanning Modal Optimization

## Problem Statement

The article publish confirmation modal currently appears whenever embedded images are detected in the content, even when those images have already been scanned or are pending ingestion. This creates unnecessary friction for users editing existing articles or re-publishing.

**Current Behavior** ([ArticleUpsertForm.tsx:180-210](../src/components/Article/ArticleUpsertForm.tsx#L180-L210)):
```typescript
const contentImages = extractImagesFromArticle(content);

if (contentImages.length > 0) {
  // ALWAYS shows modal if any images detected
  openConfirmModal({ ... });
  return;
}
submitArticle();
```

**User Impact**:
- Modal appears even when all images are already scanned
- Modal appears even when images are already pending ingestion
- Creates confusion and extra clicks for legitimate re-publishes
- Poor UX for articles being edited after initial publish

## Requirements

**Skip the modal when**:
1. All embedded images are already in the database (regardless of ingestion status)
2. Images have already been scanned (`ingestion = 'Scanned'`)
3. Images are already pending ingestion (`ingestion = 'Pending'`)
4. Images are in any known state (Error, NotFound, Blocked)

**Show the modal when**:
1. Content contains NEW images not yet in the database
2. New images will trigger scanning and delay publishing

## Analysis

### Current Architecture

**Existing Components**:
- `extractImagesFromArticle(content)` - Client/server utility to parse image URLs from HTML
- `linkArticleContentImages()` - Server function that creates Image records and ImageConnections
- `getArticleScanStatus()` - Server function that returns scan progress for an article
- `useArticleScanStatus` - React hook for polling scan status

**Image Lifecycle**:
1. User embeds image in article content (rich text editor)
2. On publish, `extractImagesFromArticle()` parses HTML for image URLs
3. `linkArticleContentImages()` creates Image records (if new) and ImageConnections
4. Images queued for ingestion via `ingestImageBulk()`
5. Webhook updates ingestion status when scans complete
6. Article auto-publishes when all images scanned

### Root Cause

The modal logic uses client-side HTML parsing only:
```typescript
const contentImages = extractImagesFromArticle(content); // Returns array of URLs
if (contentImages.length > 0) { /* show modal */ }
```

**Problem**: This check doesn't query the database to see if images already exist!

### Solution Options

#### Option A: Pre-Submit Database Check (Recommended)

**Approach**: Create new tRPC endpoint to check for new images before showing modal

**Implementation**:

1. **New tRPC endpoint** ([article.router.ts](../src/server/routers/article.router.ts)):
```typescript
checkContentImages: protectedProcedure
  .input(z.object({
    id: z.number().optional(),
    content: z.string()
  }))
  .use(isFlagProtected('articleImageScanning'))
  .query(async ({ input }) => {
    const imageUrls = extractImagesFromArticle(input.content).map(img => img.url);

    if (imageUrls.length === 0) {
      return { hasNewImages: false, newImageCount: 0, totalImages: 0 };
    }

    // Check which images already exist in database
    const existingImages = await dbRead.image.findMany({
      where: { url: { in: imageUrls } },
      select: { url: true }
    });

    const existingUrls = new Set(existingImages.map(img => img.url));
    const newImageUrls = imageUrls.filter(url => !existingUrls.has(url));

    return {
      hasNewImages: newImageUrls.length > 0,
      newImageCount: newImageUrls.length,
      totalImages: imageUrls.length,
      existingImageCount: existingImages.length
    };
  })
```

2. **Update ArticleUpsertForm** ([ArticleUpsertForm.tsx:135-210](../src/components/Article/ArticleUpsertForm.tsx#L135-L210)):
```typescript
const checkContentImagesMutation = trpc.article.checkContentImages.useMutation();

const handleSubmit = async ({ content, ...rest }: z.infer<typeof schema>) => {
  const selectedCategory = data?.items.find((cat) => cat.id === categoryId);
  const tags = selectedTags && selectedCategory
    ? selectedTags.concat([selectedCategory])
    : selectedTags;

  const submitArticle = (args?: { status?: ArticleStatus }) => {
    upsertArticleMutation.mutate(
      { ...rest, content, tags, publishedAt: publishing ? new Date() : null, ... },
      { onSuccess, onError }
    );
  };

  // Check if publishing with embedded images
  const contentImages = extractImagesFromArticle(content);

  if (contentImages.length > 0 && publishing) {
    // NEW: Check if these images are already in the database
    const checkResult = await checkContentImagesMutation.mutateAsync({
      id: article?.id,
      content
    });

    if (!checkResult.hasNewImages) {
      // All images already known to system, no delay expected
      submitArticle();
      return;
    }

    // Has new images that will need scanning, show confirmation modal
    openConfirmModal({
      title: 'Article Image Processing',
      children: (
        <Stack gap="sm">
          <Text>
            Your article contains {checkResult.newImageCount} new embedded image
            {checkResult.newImageCount > 1 ? 's' : ''} that need to be scanned for content safety.
          </Text>
          <Text>
            It will be set to <strong>Processing</strong> status while images are being scanned.
            This could take some time, and your article will automatically publish when complete.
          </Text>
          <Text size="sm" c="dimmed">
            You&apos;ll receive a notification when your article is published.
          </Text>
        </Stack>
      ),
      labels: { cancel: 'Cancel', confirm: 'Continue Publishing' },
      confirmProps: { color: 'blue' },
      onConfirm: () => submitArticle({ status: ArticleStatus.Processing }),
    });
    return;
  }

  // No images or just saving draft, proceed normally
  submitArticle();
};
```

**Pros**:
- ✅ Accurate: Queries actual database state
- ✅ Better UX: No unnecessary modal for existing images
- ✅ Reuses existing utilities (extractImagesFromArticle)
- ✅ Clean separation: Form logic stays in frontend
- ✅ Provides useful metrics (new vs existing image counts)

**Cons**:
- Adds one extra query before publish (minimal latency ~50ms)
- Requires new tRPC endpoint (small code addition)

#### Option B: Server-Side Intelligence

**Approach**: Modify upsert mutation to detect new images and return status

**Implementation**:
```typescript
// In article.service.ts - upsertArticle function
export const upsertArticle = async ({ content, ...data }) => {
  const article = await dbWrite.article.upsert({ /* ... */ });

  const contentImages = extractImagesFromArticle(content || '');

  if (contentImages.length > 0) {
    // Check for new images
    const existingImages = await dbRead.image.findMany({
      where: { url: { in: contentImages.map(img => img.url) } }
    });

    const hasNewImages = existingImages.length < contentImages.length;

    if (hasNewImages && data.publishedAt) {
      // Only set Processing if there are NEW images
      await linkArticleContentImages({ articleId: article.id, content, userId });
      await dbWrite.article.update({
        where: { id: article.id },
        data: { status: 'Processing' }
      });
    } else {
      // All existing, link but don't delay
      await linkArticleContentImages({ articleId: article.id, content, userId });
    }
  }

  return article;
};
```

**Pros**:
- ✅ No frontend changes needed
- ✅ Server has authoritative data

**Cons**:
- ❌ Modal still appears (but article doesn't actually delay)
- ❌ Confusing UX: Modal warns of delay that doesn't happen
- ❌ Can't prevent modal from frontend
- ❌ Mixed concerns: Mutation handling UI logic

#### Option C: Use Existing getScanStatus

**Approach**: Query scan status endpoint before showing modal

**Implementation**:
```typescript
const { data: scanStatus } = trpc.article.getScanStatus.useQuery(
  { id: article?.id! },
  { enabled: false } // Don't auto-fetch
);

const handleSubmit = async ({ content, ...rest }) => {
  const contentImages = extractImagesFromArticle(content);

  if (contentImages.length > 0 && publishing && article?.id) {
    // Fetch current scan status
    const status = await scanStatus.refetch();

    if (status.data?.allComplete) {
      // All existing images already scanned
      submitArticle();
      return;
    }
  }

  // Show modal or submit
};
```

**Pros**:
- ✅ Reuses existing endpoint
- ✅ No new code needed

**Cons**:
- ❌ Doesn't detect NEW images being added
- ❌ Only works for existing articles with ImageConnections
- ❌ Won't help for first publish
- ❌ Inaccurate: Reports status of OLD images, not new ones in content

## Recommended Solution

**Option A: Pre-Submit Database Check** is the best approach because:

1. **Accurate Detection**: Correctly identifies new vs existing images
2. **Best UX**: Only shows modal when truly necessary
3. **Works for All Cases**: New articles, existing articles, edits
4. **Performance**: Minimal overhead (~50ms query before publish)
5. **Clean Architecture**: Separation of concerns maintained
6. **Extensible**: Can add more logic (e.g., check ingestion status) later

## Implementation Plan

### 1. Create New tRPC Endpoint

**File**: [src/server/routers/article.router.ts](../src/server/routers/article.router.ts)

```typescript
checkContentImages: protectedProcedure
  .input(z.object({
    id: z.number().optional(),
    content: z.string()
  }))
  .use(isFlagProtected('articleImageScanning'))
  .query(async ({ input }) => {
    const imageUrls = extractImagesFromArticle(input.content).map(img => img.url);

    if (imageUrls.length === 0) {
      return { hasNewImages: false, newImageCount: 0, totalImages: 0 };
    }

    const existingImages = await dbRead.image.findMany({
      where: { url: { in: imageUrls } },
      select: { url: true }
    });

    const existingUrls = new Set(existingImages.map(img => img.url));
    const newImageUrls = imageUrls.filter(url => !existingUrls.has(url));

    return {
      hasNewImages: newImageUrls.length > 0,
      newImageCount: newImageUrls.length,
      totalImages: imageUrls.length,
      existingImageCount: existingImages.length
    };
  })
```

### 2. Update ArticleUpsertForm

**File**: [src/components/Article/ArticleUpsertForm.tsx](../src/components/Article/ArticleUpsertForm.tsx)

**Changes**:
1. Add tRPC mutation hook at component level
2. Modify `handleSubmit` to check for new images before modal
3. Update modal message to show new image count

### 3. Testing Checklist

- [ ] **New Article**: Modal shows when publishing with images
- [ ] **Existing Article**: Modal skipped if all images already scanned
- [ ] **Existing Article**: Modal skipped if images pending ingestion
- [ ] **Edit with New Images**: Modal shows for new images only
- [ ] **Edit without Changes**: Modal skipped if content unchanged
- [ ] **Draft Save**: Modal never shows (not publishing)
- [ ] **Performance**: Query completes in <100ms
- [ ] **Error Handling**: Graceful fallback if check fails

## Performance Considerations

**Query Performance**:
- Image URL lookup: ~50ms (indexed on `Image.url`)
- Total overhead: ~50-100ms before showing modal
- User-perceived: Acceptable (happens during button click)

**Database Impact**:
- Read-only query on indexed column
- Minimal load, can use read replica

**Edge Cases**:
- Query fails → Show modal (safe default)
- Network timeout → Show modal (safe default)
- Feature flag off → Current behavior (always show modal)

## Migration & Rollout

**No Migration Required** ✅

This is a purely additive feature:
- New endpoint added (no breaking changes)
- Frontend logic enhanced (backwards compatible)
- Feature flag protected (can enable/disable)

**Rollout Strategy**:
1. Deploy code with new endpoint
2. Test on staging with feature flag enabled
3. Enable in production (already gated by `articleImageScanning` flag)
4. Monitor for errors or unexpected behavior

## Success Metrics

**User Experience**:
- Reduced modal appearances for article edits
- Faster publish flow for existing content
- Clearer messaging about new vs existing images

**Technical**:
- Query latency <100ms (p95)
- Zero errors from new endpoint
- No increase in failed publishes

## Related Files

- [ArticleUpsertForm.tsx](../src/components/Article/ArticleUpsertForm.tsx) - Form submission logic
- [article.router.ts](../src/server/routers/article.router.ts) - tRPC endpoints
- [article.service.ts](../src/server/services/article.service.ts) - Business logic
- [article-helpers.ts](../src/utils/article-helpers.ts) - Image extraction utility
- [useArticleScanStatus.ts](../src/hooks/useArticleScanStatus.ts) - Scan status polling

---

**Analysis Date**: 2025-10-10
**Status**: Recommended Solution Documented
**Next Steps**: Implementation (estimated 4-6 hours)
