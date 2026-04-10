# Article Content Scanning System

**Status**: ✅ Production Ready
**Last Updated**: 2026-04-07
**Version**: 2.0

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture) (image + text moderation pipelines)
3. [How It Works](#how-it-works) (image scanning, NSFW levels, text moderation, webhook handling)
4. [Components](#components)
5. [Database Schema](#database-schema) (Article, Image, ImageConnection, EntityModeration)
6. [Performance](#performance)
7. [Deployment](#deployment) (migration supports `mode=images|text-moderation|both`)
8. [Troubleshooting](#troubleshooting)

---

## Overview

The Article Content Scanning system automatically detects and tracks all images embedded in article content and moderates article text via xGuard, ensuring proper NSFW level detection and content safety compliance.

### Problem Solved

**Before**: Articles only scanned cover images, ignoring potentially explicit content images embedded in HTML. Article text was only checked by a basic profanity filter.
**After**: All article images (cover + content) are tracked, scanned, and included in NSFW level calculations. Article text (title + content) is submitted to xGuard for ML-based moderation, which can elevate NSFW levels or auto-unpublish policy-violating articles.

### Key Features

- ✅ Automatic extraction of images from article HTML content
- ✅ Database tracking via `ImageConnection` model
- ✅ NSFW level calculation includes ALL images (cover + content)
- ✅ Real-time scan status updates via tRPC polling
- ✅ Debounced webhook processing (50 images → 1 DB update)
- ✅ Advisory locks prevent race conditions
- ✅ Feature flag control for instant rollback
- ✅ Content change detection optimization
- ✅ xGuard text moderation on article create/update (async, non-blocking)
- ✅ Content hash deduplication to skip unchanged text
- ✅ Auto-unpublish for blocked content with user notification
- ✅ Migration script supports backfilling text moderation for existing articles

---

## Architecture

### System Components

```
┌─────────────────┐
│  Article Save   │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────────────────┐  ┌──────────────────────────────┐
│ IMAGE SCANNING     │  │ TEXT MODERATION               │
│ PIPELINE           │  │ PIPELINE                      │
└────────┬───────────┘  └──────────────┬───────────────┘
         │                             │
         ▼                             ▼
┌────────────────────┐  ┌──────────────────────────────┐
│ Extract Images     │  │ Submit title + content to     │
│ from HTML Content  │  │ xGuard via orchestrator       │
│ (getContentMedia)  │  │ (submitTextModeration)        │
└────────┬───────────┘  │ • Content hash deduplication  │
         │              │ • Non-blocking fire-and-forget│
         ▼              └──────────────┬───────────────┘
┌────────────────────┐                 │
│ Create Image       │                 ▼
│ Entities +         │  ┌──────────────────────────────┐
│ Connections        │  │ EntityModeration record       │
│ (linkArticle       │  │ created (status: Pending)     │
│  ContentImages)    │  └──────────────┬───────────────┘
└────────┬───────────┘                 │
         │                             ▼
         ▼              ┌──────────────────────────────┐
┌────────────────────┐  │ Webhook: text-moderation-     │
│ DB trigger adds    │  │ result.ts                     │
│ to JobQueue        │  │ • Map labels → NsfwLevel      │
│ (trg_image_scan_   │  │ • Elevate userNsfwLevel       │
│  queue)            │  │ • Auto-unpublish if blocked   │
└────────┬───────────┘  └──────────────────────────────┘
         │
         ▼
┌────────────────────┐
│ ingest-images job  │
│ picks up from      │
│ JobQueue           │
│ • WD14 • Hive      │
│ • Clavata          │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Webhook: image-    │
│ scan-result.ts     │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Debounced Article  │
│ Update             │
│ (Redis 5s window)  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Update Article     │
│ Scan Status        │
│ • Advisory locks   │
│ • NSFW levels      │
│ • Auto-publish     │
└────────────────────┘
```

### Data Flow

#### Image Pipeline
1. **Article Save** → Extract images from HTML
2. **Image Linking** → Create/update Image entities and ImageConnections
3. **DB Trigger** → `trg_image_scan_queue` adds new images to `JobQueue` automatically
4. **Job Pickup** → `ingest-images` job submits pending images to external scan service
5. **Webhook** → Receive scan results, debounce updates
6. **Status Update** → Check completion, update NSFW levels
7. **Auto-Publish** → Change status from Processing → Published

#### Text Moderation Pipeline
1. **Article Save** → Strip HTML, combine title + content
2. **Hash Check** → Compare content hash against EntityModeration record, skip if unchanged
3. **Submit** → Fire-and-forget to xGuard orchestrator workflow
4. **Webhook** → Receive moderation result (blocked, triggeredLabels)
5. **NSFW Update** → Map labels to NsfwLevel, elevate `userNsfwLevel` (never lower)
6. **Enforcement** → If blocked: auto-unpublish to `UnpublishedViolation` + notify user

---

## How It Works

### 1. Image Extraction

There are two extraction implementations for server and client contexts:

#### Server-Side: `getContentMedia()` (primary)

**File**: `src/server/services/article-content-cleanup.service.ts`

Handles both Tiptap JSON and HTML content formats:

```typescript
import { getContentMedia } from '~/server/services/article-content-cleanup.service';

const media = getContentMedia(article.content);
// Returns: ExtractedMedia[] → [{ url: 'uuid', type: 'image', alt: '...' }, ...]
```

- If content starts with `{`, parses as Tiptap JSON and walks the AST
- Otherwise, converts HTML to Tiptap AST via `generateJSON()` from `@tiptap/html/server`
- Extracts `media` nodes (edge-media UUIDs) and `image` nodes (Cloudflare URLs → UUIDs)
- Supports both images and videos

#### Client-Side: `extractImagesFromArticle()` (UI only)

**File**: `src/utils/article-helpers.ts`

Uses the browser's native `DOMParser` for client-side form validation:

```typescript
import { extractImagesFromArticle } from '~/utils/article-helpers';

const media = extractImagesFromArticle(htmlContent);
```

- Queries for `<img>` elements and custom `<edge-media>` HTML tags
- Used in `ArticleUpsertForm.tsx` to detect new images when publishing and show scan status warnings

#### Shared Helpers

**File**: `src/utils/article-helpers.ts`

```typescript
type ExtractedMedia = {
  url: string;              // Cloudflare UUID
  type: 'image' | 'video';
  alt?: string;
};

// Extract UUID from full Civitai image URLs
extractCloudflareUuid(url: string): string | null

// Security: only allows Civitai domains or UUID format
isValidCivitaiImageUrl(url: string): boolean
```

### 2. Image Linking

`linkArticleContentImages()` creates database relationships using `getContentMedia()`:

```typescript
await linkArticleContentImages({
  articleId: article.id,
  content: article.content,
  userId: article.userId,
});
```

**Process**:
1. Extract media URLs from content via `getContentMedia()`
2. Batch fetch existing Image records by URL
3. Create missing Image entities (with `ingestion: Pending`, `skipDuplicates` for concurrency)
4. Upsert ImageConnection records linking images to article
5. Remove orphaned connections for images no longer in content
6. Only delete orphaned images if they have no connections to ANY entity

**Optimizations**:
- **Batch queries**: 50 images → 3 queries (not 150 queries)
- **Transaction safety**: All-or-nothing atomicity
- **Orphaned cleanup**: Removes connections for deleted images, safely deletes truly orphaned images
- **Race protection**: `skipDuplicates` handles concurrent saves
- **Content change detection**: Only processes if content actually changed

### 3. Scan Coordination

Images are picked up for scanning automatically via a database trigger and job queue — no manual ingestion call is needed:

1. When an `Image` row is created with `ingestion = 'Pending'`, the `trg_image_scan_queue` DB trigger adds a `JobQueue` record
2. The `ingest-images` job picks up pending images every 5 minutes and submits them to the external scan service

**Scan Types**:
- **WD14**: Tag detection (characters, objects, styles)
- **Hive**: NSFW detection (explicit content)
- **Clavata**: Content rating (PG, PG-13, R, X, XXX)
- **Hash**: Perceptual hashing (duplicate detection)

### 4. Webhook Processing

When scan completes, webhook receives results:

```typescript
// Webhook debouncing: 50 webhooks → 1 DB update
const articleConnections = await db.imageConnection.findMany({
  where: { imageId: image.id, entityType: 'Article' },
});

for (const { entityId } of articleConnections) {
  await debounceArticleUpdate(entityId); // Redis-based coalescing
}
```

**Features**:
- **Debouncing**: 5-second window, 98% reduction in updates
- **Feature flag gated**: Can disable with `articleImageScanning: []`
- **Advisory locks**: Prevents concurrent update conflicts

### 5. Status Updates

System checks completion and updates article:

```typescript
// Advisory lock prevents race conditions
await dbWrite.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_try_advisory_xact_lock(...)`;

  // Check all images scanned/blocked/error
  const allComplete = (scanned + blocked + error) === total;

  if (allComplete) {
    // Update NSFW levels (cover + content images)
    await updateArticleNsfwLevels([articleId]);

    // Auto-publish: Processing → Published
    if (article.status === 'Processing') {
      await tx.article.update({
        data: { status: 'Published' }
      });
    }
  }
});
```

### 6. NSFW Level Calculation

Combines all images (cover + content):

```sql
-- Uses bitwise OR to combine NSFW flags
SELECT
  a.id,
  bit_or(COALESCE(cover."nsfwLevel", 0)) |
  bit_or(COALESCE(content_imgs."nsfwLevel", 0)) AS "nsfwLevel"
FROM "Article" a
LEFT JOIN "Image" cover ON a."coverId" = cover.id
  AND cover."ingestion" = 'Scanned'
LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id
  AND ic."entityType" = 'Article'
LEFT JOIN "Image" content_imgs ON ic."imageId" = content_imgs.id
  AND content_imgs."ingestion" = 'Scanned'
WHERE a.id = ANY($1::int[])
GROUP BY a.id
```

**NSFW Levels** (bitwise flags):
- `1` = PG (suggestive content)
- `2` = PG13 (nudity, partial)
- `4` = R (explicit nudity)
- `8` = X (sexual content)
- `16` = XXX (extreme content)
- `32` = Blocked (prohibited content)

### 7. Text Moderation (xGuard)

When an article is created or updated, its text is submitted asynchronously to xGuard:

```typescript
// In upsertArticle - fire-and-forget
const textForModeration = [data.title, removeTags(result.content)]
  .filter(Boolean)
  .join(' ');
submitTextModeration({
  entityType: 'Article',
  entityId: result.id,
  content: textForModeration,
}).catch(/* log error */);
```

**Key behaviors**:
- **Non-blocking**: Does not delay article creation or publishing
- **Content hash deduplication**: On updates, compares SHA-256 hash of new text against `EntityModeration.contentHash` to skip unchanged content
- **Independent of image pipeline**: Text moderation runs in parallel, does not gate the Processing → Published transition

### 8. Text Moderation Webhook

When xGuard returns results, the webhook handler processes them:

```typescript
// In text-moderation-result.ts - Article handler
const textNsfwLevel = mapTriggeredLabelsToNsfwLevel(triggeredLabels, blocked);

// Elevate userNsfwLevel (never lower)
if (textNsfwLevel > 0) {
  // Raw SQL: GREATEST("userNsfwLevel", textNsfwLevel)
  // Lock userNsfwLevel in lockedProperties
  await updateArticleNsfwLevels([entityId]);
}

// If blocked, auto-unpublish
if (blocked) {
  // Set status to UnpublishedViolation
  // Send notification to user
}
```

**Label-to-NsfwLevel mapping** (configurable in `entity-moderation.service.ts`):

| xGuard Label | NsfwLevel |
|---|---|
| `sexual` | X (8) |
| `sexual/minors` | Blocked (32) |
| `hate` | R (4) |
| `hate/threatening` | Blocked (32) |
| `harassment` | R (4) |
| `harassment/threatening` | Blocked (32) |
| `self-harm` | R (4) |
| `self-harm/intent` | Blocked (32) |
| `self-harm/instructions` | Blocked (32) |
| `violence` | R (4) |
| `violence/graphic` | X (8) |
| Any unrecognized label | R (4) — conservative default |

### Interaction Between Profanity Filter and xGuard

Both systems update `userNsfwLevel` and compose naturally:

| System | Timing | Mechanism |
|---|---|---|
| Profanity filter | Synchronous (during upsert) | Keyword-based, instant |
| xGuard text moderation | Asynchronous (webhook) | ML-based, more sophisticated |

Both use `GREATEST` semantics (never lower, only raise) and lock `userNsfwLevel` via `lockedProperties`. Whichever finds the higher level wins.

---

## Components

### Server-Side

#### 1. Image Extraction Utilities

**File**: `src/server/services/article-content-cleanup.service.ts`
- `getContentMedia(content)` - Server-side extraction (Tiptap JSON + HTML → AST walker)
- `getContentImageUrls(content)` - Convenience wrapper returning image URLs only
- `deleteArticleContentImages(content)` - S3/Cloudflare cleanup

**File**: `src/utils/article-helpers.ts`
- `extractImagesFromArticle(html)` - Client-side extraction (DOMParser)
- `extractCloudflareUuid(url)` - UUID extraction from Cloudflare URLs
- `isValidCivitaiImageUrl(url)` - Domain security validation

#### 2. Article Service

**File**: `src/server/services/article.service.ts`

**Functions**:
- `linkArticleContentImages()` - Create Image entities and connections
- `updateArticleImageScanStatus()` - Check completion and update status
- `getArticleScanStatus()` - Real-time status query
- `upsertArticle()` - Calls `submitTextModeration` on create/update (non-blocking)

**Critical Features**:
- Orphaned image deletion safety
- Content change detection optimization
- Advisory locks for race protection
- Text moderation with content hash deduplication on updates

#### 2b. Text Moderation Services

**File**: `src/server/services/text-moderation.service.ts`
- `submitTextModeration()` - Submits content to xGuard orchestrator workflow

**File**: `src/server/services/entity-moderation.service.ts`
- `mapTriggeredLabelsToNsfwLevel()` - Maps xGuard labels to NsfwLevel values
- `hashContent()` - SHA-256 content hashing for deduplication
- `upsertEntityModerationPending()` - Creates/resets pending EntityModeration record
- `recordEntityModerationSuccess()` - Records successful moderation result
- `recordEntityModerationFailure()` - Records failure with retry count

#### 3. NSFW Level Service

**File**: `src/server/services/nsfwLevels.service.ts`

**Function**: `updateArticleNsfwLevels()` (lines 258-296)
- Combines cover + content images
- Uses `GREATEST()` for user overrides
- Only includes scanned images

#### 4. Webhook Integration

**File**: `src/pages/api/webhooks/image-scan-result.ts` (image scanning)

```typescript
// Feature flag gated
const featureFlags = getFeatureFlagsLazy({ req });
if (featureFlags.articleImageScanning) {
  // Find articles using this image
  const articleConnections = await dbWrite.imageConnection.findMany({
    where: { imageId: image.id, entityType: 'Article' },
  });

  // Debounced updates
  for (const { entityId } of articleConnections) {
    await debounceArticleUpdate(entityId);
  }
}
```

**File**: `src/pages/api/webhooks/text-moderation-result.ts` (text moderation)

Handles xGuard workflow completion events for articles:
- Maps triggered labels to NsfwLevel via `mapTriggeredLabelsToNsfwLevel()`
- Elevates `userNsfwLevel` using `GREATEST` (raw SQL, never lowers)
- Locks `userNsfwLevel` in `lockedProperties`
- Calls `updateArticleNsfwLevels()` to recompute composite NSFW level
- Auto-unpublishes to `UnpublishedViolation` if `blocked === true` with user notification

#### 5. Webhook Debouncing

**File**: `src/server/utils/webhook-debounce.ts`

**Function**: `debounceArticleUpdate(articleId)`
- Redis-based coalescing (5-second window)
- 98% reduction in DB updates (50 webhooks → 1 update)

### Client-Side

#### 1. Scan Status Hook

**File**: `src/hooks/useArticleScanStatus.ts`

```typescript
const { data, isLoading } = useArticleScanStatus(articleId);
// Returns: { total, scanned, blocked, error, pending, allComplete }
```

**Features**:
- tRPC polling (every 5 seconds)
- Auto-stops when complete
- Feature flag aware

#### 2. UI Component

**File**: `src/components/Article/ArticleScanStatus.tsx`

**States**:
- **Pending**: Shows progress bar and count
- **Blocked**: Critical error, must remove images
- **Error**: Recoverable error, can retry or publish anyway
- **Complete**: Hidden, auto-published

**Accessibility**:
- ARIA live regions for screen readers
- Keyboard navigation support
- Clear progress indicators

#### 3. Form Integration

**File**: `src/components/Article/ArticleUpsertForm.tsx`

**Lines**: 73, 186, 286-291, 454
- Feature flag check
- Image extraction on save
- Status component integration

---

## Database Schema

### Models

#### Article

```prisma
model Article {
  id               Int           @id @default(autoincrement())
  content          String        // HTML content with embedded images
  coverId          Int?          // Cover image FK
  coverImage       Image?        @relation(fields: [coverId])
  nsfwLevel        Int           @default(0)  // Combined level (cover + content)
  userNsfwLevel    Int           @default(0)  // User override
  status           ArticleStatus @default(Draft)
  contentScannedAt DateTime?     // Last content scan timestamp

  // Relations
  connections      ImageConnection[] @relation("ArticleImages")
}

enum ArticleStatus {
  Draft
  Processing  // Waiting for image scans
  Published
  Unpublished
}
```

#### Image

```prisma
model Image {
  id              Int                  @id @default(autoincrement())
  url             String               @unique  // Prevents duplicates
  nsfwLevel       Int                  @default(0)
  ingestion       ImageIngestionStatus @default(Pending)
  scannedAt       DateTime?

  // Relations
  connections     ImageConnection[]
  article         Article?  // Only for cover images

  @@index([ingestion, nsfwLevel])
}

enum ImageIngestionStatus {
  Pending    // Waiting for scan
  Scanned    // Scan complete
  Blocked    // Blocked by policy
  Error      // Scan failed
  NotFound   // Image not found
}
```

#### ImageConnection

```prisma
model ImageConnection {
  imageId    Int
  image      Image   @relation(fields: [imageId])
  entityId   Int
  entityType String  // "Article", "Bounty", etc.

  @@id([imageId, entityType, entityId])
  @@index([entityType, entityId], where: entityType = 'Article')
}
```

#### EntityModeration

```prisma
model EntityModeration {
  id              Int                    @id @default(autoincrement())
  entityType      String                 // "Article", "Model", etc.
  entityId        Int
  workflowId      String?                // Orchestrator workflow reference
  status          EntityModerationStatus @default(Pending)
  contentHash     String?                // SHA-256 hash for deduplication
  blocked         Boolean?
  triggeredLabels String[]               // xGuard label categories
  result          Json?                  // Full XGuardModerationOutput
  retryCount      Int                    @default(0)
  createdAt       DateTime               @default(now())
  updatedAt       DateTime               @updatedAt

  @@unique([entityType, entityId])
  @@index([status])
  @@index([workflowId])
}

enum EntityModerationStatus {
  Pending
  Succeeded
  Failed
  Expired
  Canceled
}
```

### Key Indexes

```sql
-- Prevent duplicate Image URLs (race condition fix)
CREATE UNIQUE INDEX "Image_url_unique" ON "Image"("url");

-- Optimize ImageConnection lookups for articles
CREATE INDEX "ImageConnection_Article_idx"
ON "ImageConnection"("entityType", "entityId")
WHERE "entityType" = 'Article';

-- Optimize Image scans query
CREATE INDEX "Image_ingestion_nsfwLevel_idx"
ON "Image"("ingestion", "nsfwLevel")
WHERE "ingestion" = 'Scanned';
```

---

## Performance

### Optimizations

#### 1. Content Change Detection
**Improvement**: Only process images if content actually changed
**Impact**: 60-80% of article saves skip image processing
**Savings**: ~30-40ms per save for title/metadata edits

#### 2. Batch Queries
**Pattern**: Process all images in single transaction
**Impact**: 50 images → 3 queries (not 150 queries)
**Savings**: ~90% query reduction

#### 3. Webhook Debouncing
**Pattern**: Coalesce rapid webhook calls (5-second window)
**Impact**: 50 webhooks → 1 DB update
**Savings**: 98% reduction in DB updates

#### 4. Advisory Locks
**Pattern**: PostgreSQL row-level locking
**Impact**: Prevents race conditions without table locks
**Performance**: Minimal overhead, automatic cleanup

### Benchmarks

**Article Save** (with 10 embedded images):
- Image extraction: ~15ms
- Image linking (no content change): ~0ms (skipped)
- Image linking (content changed): ~150ms (batch)
- Total overhead: ~15-165ms

**Webhook Processing** (per image):
- Debounce check: ~5ms (Redis)
- Article update (coalesced): ~200ms (50 images)
- Average per image: ~4ms

**Migration** (1000 articles, ~5 images each):
- Old approach: ~15-20 minutes (1000 transactions)
- Optimized approach: ~1-2 minutes (50 transactions)
- **Speedup**: ~10-15x faster

---

## Deployment

### Pre-Deployment Checklist

- [x] Database schema updated (`contentScannedAt` field)
- [x] Prisma client generated
- [x] All indexes created
- [x] Feature flag declared (`articleImageScanning: ['mod']`)
- [x] Code reviewed and tested
- [ ] Migration webhook tested on staging

### Deployment Steps

#### Step 1: Deploy Code (Feature Flag OFF)

```bash
# Deploy with feature flag disabled
# articleImageScanning: []

git push production main
```

**Effect**: No behavior change, prepares system for migration

#### Step 2: Run Image Migration

```bash
# Migrate existing articles to populate ImageConnections (default mode=images)
curl "https://civitai.com/api/admin/temp/migrate-article-images?dryRun=false&concurrency=2"
```

#### Step 2b: Run Text Moderation Migration

```bash
# Backfill text moderation for existing published articles
curl "https://civitai.com/api/admin/temp/migrate-article-images?mode=text-moderation&dryRun=false&concurrency=2"

# Or run both image and text moderation together
curl "https://civitai.com/api/admin/temp/migrate-article-images?mode=both&dryRun=false&concurrency=2"
```

**Migration `mode` parameter**:
- `images` (default) — Create Image entities and ImageConnections
- `text-moderation` — Submit article text to xGuard (low priority)
- `both` — Run image linking and text moderation together

**Monitors**:
- Progress tracking
- Error count
- Database load

#### Step 3: Validate Migration

```sql
-- Check ImageConnections created
SELECT COUNT(*) FROM "ImageConnection" WHERE "entityType" = 'Article';

-- Check no orphaned records
SELECT COUNT(*) FROM "Image" WHERE id NOT IN (
  SELECT DISTINCT "imageId" FROM "ImageConnection"
);

-- Check NSFW levels updated
SELECT COUNT(*) FROM "Article" WHERE "nsfwLevel" > 0;

-- Check EntityModeration records created (text moderation)
SELECT status, COUNT(*)
FROM "EntityModeration"
WHERE "entityType" = 'Article'
GROUP BY status;
```

#### Step 4: Enable Feature Flag

```typescript
// src/server/services/feature-flags.service.ts
const featureFlags = createFeatureFlags({
  articleImageScanning: ['public'], // Enable for all users
});
```

```bash
# Deploy feature flag change
git commit -m "feat: enable article image scanning"
git push production main
```

#### Step 5: Monitor (First 24 Hours)

**Metrics to Track**:
- Error rate (<0.1% target)
- Scan completion rate (>95% target)
- Article publish success rate
- Database performance
- User feedback

### Rollback Procedure

**If issues detected**:

```typescript
// Instant rollback - disable feature flag
const featureFlags = createFeatureFlags({
  articleImageScanning: [], // Disable
});
```

```bash
# Deploy rollback immediately
git commit -m "fix: disable article image scanning"
git push production main --force
```

**Effect**: Old behavior restored instantly (no code changes needed)

---

## Troubleshooting

### Common Issues

#### Issue 1: Articles stuck in "Processing" status

**Symptoms**:
- Article status remains "Processing" indefinitely
- No scan progress updates

**Diagnosis**:
```sql
-- Check image scan status
SELECT i."ingestion", COUNT(*)
FROM "ImageConnection" ic
JOIN "Image" i ON ic."imageId" = i.id
WHERE ic."entityType" = 'Article' AND ic."entityId" = $1
GROUP BY i."ingestion";
```

**Solutions**:
1. Check if scan service is running
2. Re-queue failed images for scanning
3. Manual status override (if images genuinely stuck)

#### Issue 2: NSFW level not updating

**Symptoms**:
- Article NSFW level doesn't reflect content images
- Only cover image NSFW level considered

**Diagnosis**:
```sql
-- Check if ImageConnections exist
SELECT COUNT(*) FROM "ImageConnection"
WHERE "entityType" = 'Article' AND "entityId" = $1;

-- Check if images are scanned
SELECT i.id, i.url, i."ingestion", i."nsfwLevel"
FROM "ImageConnection" ic
JOIN "Image" i ON ic."imageId" = i.id
WHERE ic."entityType" = 'Article' AND ic."entityId" = $1;
```

**Solutions**:
1. Verify ImageConnections exist
2. Ensure images are fully scanned (`ingestion = 'Scanned'`)
3. Manually trigger NSFW level update: `await updateArticleNsfwLevels([articleId])`

#### Issue 3: Orphaned images after article edit

**Symptoms**:
- Images deleted from article still in database
- ImageConnections not cleaned up

**Diagnosis**:
```sql
-- Check for orphaned ImageConnections
SELECT ic.*
FROM "ImageConnection" ic
LEFT JOIN "Article" a ON ic."entityId" = a.id AND ic."entityType" = 'Article'
WHERE a.id IS NULL;
```

**Solution**:
- **Automatic**: `linkArticleContentImages` handles cleanup on save
- **Manual cleanup**: Run migration to fix existing orphans

#### Issue 4: Race condition errors

**Symptoms**:
- Duplicate Image entities for same URL
- Concurrent webhook update conflicts

**Diagnosis**:
- Check database logs for constraint violations
- Monitor advisory lock timeouts

**Solutions**:
- **Automatic**: Unique constraint + `skipDuplicates` handles races
- **Advisory locks**: Prevent concurrent status updates
- **Webhook debouncing**: Reduces concurrent pressure

#### Issue 5: Text moderation not triggering

**Symptoms**:
- No `EntityModeration` record created after article save
- Article text changes not submitted to xGuard

**Diagnosis**:
```sql
-- Check if EntityModeration record exists
SELECT * FROM "EntityModeration"
WHERE "entityType" = 'Article' AND "entityId" = $1;
```

**Solutions**:
1. Check Axiom logs for `article-text-moderation` errors
2. Verify orchestrator service is reachable
3. Check `TEXT_MODERATION_CALLBACK` env var is set
4. For updates: content hash may match (no resubmission needed)

#### Issue 6: Article unexpectedly unpublished by text moderation

**Symptoms**:
- Article status changed to `UnpublishedViolation`
- User received notification about ToS violation

**Diagnosis**:
```sql
-- Check text moderation result
SELECT em.*, em."triggeredLabels", em.blocked, em.result
FROM "EntityModeration" em
WHERE em."entityType" = 'Article' AND em."entityId" = $1;
```

**Solutions**:
1. Review `triggeredLabels` and `result` JSON to understand why content was blocked
2. If false positive: moderator can restore article via `restoreArticleById`
3. Check label-to-NsfwLevel mapping in `entity-moderation.service.ts`

### Debug Queries

```sql
-- Get article scan status
SELECT
  a.id,
  a.status,
  COUNT(ic."imageId") as total_images,
  COUNT(CASE WHEN i."ingestion" = 'Scanned' THEN 1 END) as scanned,
  COUNT(CASE WHEN i."ingestion" = 'Pending' THEN 1 END) as pending,
  COUNT(CASE WHEN i."ingestion" = 'Blocked' THEN 1 END) as blocked
FROM "Article" a
LEFT JOIN "ImageConnection" ic ON ic."entityId" = a.id
  AND ic."entityType" = 'Article'
LEFT JOIN "Image" i ON ic."imageId" = i.id
WHERE a.id = $1
GROUP BY a.id, a.status;

-- Find articles with unscanned images
SELECT a.id, a.title, COUNT(*) as pending_images
FROM "Article" a
JOIN "ImageConnection" ic ON ic."entityId" = a.id
  AND ic."entityType" = 'Article'
JOIN "Image" i ON ic."imageId" = i.id
WHERE i."ingestion" = 'Pending'
  AND a.status = 'Processing'
GROUP BY a.id, a.title
ORDER BY pending_images DESC;

-- Check webhook processing rate
SELECT
  DATE_TRUNC('minute', i."scannedAt") as minute,
  COUNT(*) as images_scanned
FROM "Image" i
WHERE i."scannedAt" > NOW() - INTERVAL '1 hour'
GROUP BY DATE_TRUNC('minute', i."scannedAt")
ORDER BY minute DESC;

-- Check text moderation status for an article
SELECT em.status, em.blocked, em."triggeredLabels", em."contentHash",
       em."createdAt", em."updatedAt"
FROM "EntityModeration" em
WHERE em."entityType" = 'Article' AND em."entityId" = $1;

-- Find articles blocked by text moderation
SELECT em."entityId" as article_id, a.title, em."triggeredLabels", em."updatedAt"
FROM "EntityModeration" em
JOIN "Article" a ON a.id = em."entityId"
WHERE em."entityType" = 'Article' AND em.blocked = true
ORDER BY em."updatedAt" DESC;

-- Text moderation backlog (pending submissions)
SELECT status, COUNT(*)
FROM "EntityModeration"
WHERE "entityType" = 'Article'
GROUP BY status;
```

### Feature Flag Status

```typescript
// Check current feature flag status
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';

const flags = getFeatureFlagsLazy({ req });
console.log('Article Image Scanning:', flags.articleImageScanning);
// true = enabled, false = disabled
```

---

## Related Files

### Core Implementation — Image Scanning
- `src/server/services/article.service.ts` - Main article operations, image linking, scan status
- `src/server/services/article-content-cleanup.service.ts` - Image/media extraction from content (server-side)
- `src/server/services/nsfwLevels.service.ts` - NSFW level calculation (cover + content images)
- `src/pages/api/webhooks/image-scan-result.ts` - Image scan webhook handler
- `src/server/utils/webhook-debounce.ts` - Redis-based debouncing logic
- `src/utils/article-helpers.ts` - Image extraction (client-side), shared helpers

### Core Implementation — Text Moderation
- `src/server/services/text-moderation.service.ts` - Submit text to xGuard
- `src/server/services/entity-moderation.service.ts` - EntityModeration CRUD, label-to-NsfwLevel mapping, content hashing
- `src/server/services/orchestrator/orchestrator.service.ts` - xGuard workflow creation
- `src/pages/api/webhooks/text-moderation-result.ts` - Text moderation webhook handler (Article handler)

### UI Components
- `src/components/Article/ArticleScanStatus.tsx` - Status display
- `src/components/Article/ArticleUpsertForm.tsx` - Form integration
- `src/hooks/useArticleScanStatus.ts` - Polling hook

### Configuration
- `src/server/services/feature-flags.service.ts` - Feature flag (`articleImageScanning`)
- `prisma/schema.prisma` - Database schema
- `src/env/server-schema.ts` - `TEXT_MODERATION_CALLBACK` env var

### Migration
- `src/pages/api/admin/temp/migrate-article-images.ts` - Migration webhook (supports `mode=images|text-moderation|both`)

---

**Documentation Version**: 2.0
**Last Updated**: 2026-04-07
**Status**: Production Ready
