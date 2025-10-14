# Article Image Scanning Analysis & Implementation Plan

**Date**: 2025-10-06
**Issue**: Articles with embedded images need NSFW level detection based on all content images, not just cover image
**Current Problem**: No direct DB link between articles and embedded HTML images; articles can't wait for scans

---

## 🔍 Current State Analysis

### Database Schema

**Article Model** ([prisma/schema.prisma:2359](/Users/hackstreetboy/Projects/civitai/prisma/schema.prisma#L2359)):
```prisma
model Article {
  id               Int           @id @default(autoincrement())
  content          String        // Raw HTML stored as text
  cover            String?       // URL (not tracked as image entity)
  coverId          Int?          @unique
  coverImage       Image?        @relation(fields: [coverId], references: [id])
  nsfwLevel        Int           @default(0)
  userNsfwLevel    Int           @default(0)
  status           ArticleStatus @default(Draft)
  // ... other fields
}

enum ArticleStatus {
  Draft
  Published
  Unpublished
}
```

**Image Model** ([prisma/schema.prisma:1362](/Users/hackstreetboy/Projects/civitai/prisma/schema.prisma#L1362)):
```prisma
model Image {
  id              Int                  @id @default(autoincrement())
  nsfwLevel       Int                  @default(0)
  ingestion       ImageIngestionStatus @default(Pending)
  scannedAt       DateTime?
  scanRequestedAt DateTime?
  scanJobs        Json?
  // ... other fields

  connections     ImageConnection[]  // Generic entity linking
  article         Article?           // Only for cover images
}

model ImageConnection {
  imageId    Int
  image      Image  @relation(...)
  entityId   Int
  entityType String  // e.g., "Bounty", "BountyEntry"

  @@id([imageId, entityType, entityId])
}
```

**Key Observations**:
1. ✅ `ImageConnection` exists for linking images to entities
2. ❌ Currently used for Bounties, NOT for Article content images
3. ❌ Article `content` is raw HTML string - images referenced by URL only
4. ✅ Only `coverImage` has direct FK relationship

### Current Image Scanning Workflow

**Scan Process** ([src/pages/api/webhooks/image-scan-result.ts](/Users/hackstreetboy/Projects/civitai/src/pages/api/webhooks/image-scan-result.ts:1)):

```typescript
// Webhook receives scan results from external service
Status.Success → handleSuccess() → processScanResult() → auditImageScanResults()

// Image ingestion states
enum ImageIngestionStatus {
  Pending    // Waiting for scan
  Scanned    // Scan complete
  Blocked    // Blocked by scan
  Error      // Scan failed
  NotFound   // Image not found
}

// Required scans (must complete all before "Scanned")
const imageScanTypes = [
  ImageScanType.WD14,         // Tag detection
  ImageScanType.Hash,         // Perceptual hash
  ImageScanType.Hive,         // NSFW detection
  ImageScanType.Clavata,      // Content rating
  // ... others
];
```

**Post-Scan Actions** ([image-scan-result.ts:226-306](/Users/hackstreetboy/Projects/civitai/src/pages/api/webhooks/image-scan-result.ts#L226)):
```typescript
async function updateImage(image, result) {
  await dbWrite.image.update({ where: { id }, data });

  if (data.ingestion === 'Scanned') {
    // Update connected entity NSFW levels
    if (image.postId) await updatePostNsfwLevel(image.postId);

    // ❌ NO ARTICLE UPDATE HERE!
  }
}
```

### Current Article NSFW Logic

**Update Function** ([src/server/services/nsfwLevels.service.ts:257](/Users/hackstreetboy/Projects/civitai/src/server/services/nsfwLevels.service.ts#L257)):
```typescript
export async function updateArticleNsfwLevels(articleIds: number[]) {
  // ❌ ONLY considers coverImage, NOT content images
  const articles = await dbWrite.$queryRaw`
    WITH level AS (
      SELECT DISTINCT ON (a.id) a.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Article" a
      JOIN "Image" i ON a."coverId" = i.id  -- Only cover!
      WHERE a.id IN (${Prisma.join(articleIds)})
      GROUP BY a.id
    )
    UPDATE "Article" a SET "nsfwLevel" = (
      CASE WHEN a."userNsfwLevel" > a."nsfwLevel"
           THEN a."userNsfwLevel"
           ELSE level."nsfwLevel"
      END
    )
    FROM level WHERE level.id = a.id
    RETURNING a.id;
  `;
}
```

**Article Upsert** ([src/server/services/article.service.ts:668](/Users/hackstreetboy/Projects/civitai/src/server/services/article.service.ts#L668)):
```typescript
upsertArticle = async ({ content, coverImage, ...data }) => {
  // Profanity check on text content
  const textToCheck = [data.title, data.content].join(' ');
  const { isProfane } = profanityFilter.analyze(textToCheck);
  if (isProfane) {
    data.nsfw = true;
    data.userNsfwLevel = NsfwLevel.R;
  }

  // Cover image handling
  if (coverImage && !coverId) {
    const result = await createImage({ ...coverImage, userId });
    coverId = result.id;
  }

  // ❌ Content images NOT extracted or tracked
  await dbWrite.article.create({ data: { ...data, content, coverId } });
};
```

---

## ⚠️ Identified Problems

### 1. **No Content Image Tracking** 🔴 CRITICAL
**Problem**: Images embedded in article content (via TipTap HTML) are not tracked as `Image` entities with `ImageConnection`.

**Current Flow**:
```
User uploads image → S3 URL → Insert into TipTap → Save as raw HTML string
                                                    ↓
                                          Article.content = "<img src='https://...'/>"
```

**Missing**:
- No `Image` record created for content images
- No `ImageConnection` linking images to article
- No scan triggers for content images
- No way to track scan completion

### 2. **Incomplete NSFW Detection** 🔴 CRITICAL
**Problem**: Article NSFW level only considers cover image, ignoring potentially explicit content images.

**Risk Scenario**:
```
Article cover: PG-rated image ✅
Article content: XXX-rated images ❌ (not scanned)
Result: Article shows as safe, displays explicit content
```

### 3. **No Scan Coordination** 🟡 MODERATE
**Problem**: No mechanism to:
- Know when all article images are scanned
- Keep article hidden until scans complete
- Handle scan failures gracefully

**Current State**:
```typescript
// Articles can be published immediately
status: ArticleStatus.Published  // No "Pending" state
publishedAt: new Date()          // Immediate visibility
```

### 4. **HTML Parsing Gap** 🟡 MODERATE
**Problem**: No utility to extract image URLs from TipTap HTML content.

**Need**:
```typescript
// Extract all images from article content
parseArticleContent(htmlContent) → [
  { url: 'https://image.civitai.com/...', alt: '...' },
  { url: 'https://civitai-prod.s3...', alt: '...' }
]
```

---

## 💡 Proposed Solution

> **⚠️ ARCHITECTURE REVIEW UPDATES (2025-10-06)**
>
> This solution has been reviewed by backend and frontend architecture experts. Critical improvements have been identified:
>
> **Backend Critical Issues**:
> - 🔴 Race conditions in concurrent webhook processing (needs row-level locking)
> - 🔴 N+1 webhook performance issue (needs debouncing/queue)
> - 🔴 Missing unique constraint on `Image.url` (could create duplicates)
> - 🔴 Migration lacks transaction safety
> - 🟡 Missing database indexes for new query patterns
>
> **Frontend Critical Issues**:
> - 🔴 Orphaned images from editor uploads (create on save, not upload)
> - 🔴 No real-time scan status updates (needs tRPC polling/subscriptions)
> - 🔴 Missing error recovery workflows (blocked/failed images)
> - 🟡 Confusing "PendingReview" status (suggest "Processing" instead)
>
> See `docs/architectural-considerations.md` for detailed fixes and `docs/article-image-scanning-workflow.md` for revised timeline (5 weeks instead of 4).

### Phase 1: Database Schema Changes

**1.1 Add Article Status for Scanning**
```prisma
enum ArticleStatus {
  Draft
  Processing       // REVISED: Was "PendingReview" - clearer terminology
  Published
  Unpublished
}
```

**1.2 Use Existing ImageConnection**
```prisma
// NO schema changes needed!
// Leverage existing ImageConnection model

model ImageConnection {
  imageId    Int
  entityId   Int
  entityType String  // Add "Article" as valid type

  @@id([imageId, entityType, entityId])
  @@index([entityType, entityId])  // ✅ Already exists
}
```

**🔴 CRITICAL: Add Missing Database Constraints & Indexes**

> **📝 NOTE**: Most indexes already exist in production database. This section documents what's needed for completeness. Before running migrations, verify which indexes are already present.

```sql
-- 1. Prevent duplicate Image URLs (prevents race conditions)
-- ⚠️ CHECK FIRST: May already exist in production
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Image_url_unique" ON "Image"("url");

-- 2. Optimize ImageConnection lookups for articles
-- ⚠️ CHECK FIRST: May already exist in production
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageConnection_Article_idx"
ON "ImageConnection"("entityType", "entityId")
WHERE "entityType" = 'Article';

-- 3. Optimize Image scans query
-- ⚠️ CHECK FIRST: May already exist in production
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_ingestion_nsfwLevel_idx"
ON "Image"("ingestion", "nsfwLevel")
WHERE "ingestion" = 'Scanned';
```

**🛑 MANUAL MIGRATION CHECKPOINT**: After generating Prisma migrations, STOP and coordinate with team to:
1. Verify which indexes already exist in production
2. Manually run only the missing migrations
3. Update Prisma schema to reflect existing indexes
4. Confirm all constraints are in place before continuing implementation

**1.3 Metadata Storage - Compute, Don't Cache**
```prisma
model Article {
  metadata Json? @default("{}")
  // ⚠️ ARCHITECTURE NOTE: Don't cache derived state (imagesPending, imagesScanned)
  // Instead, compute real-time from ImageConnection to avoid inconsistency
  // Use metadata only for non-derived info (error messages, user notes)
}
```

### Phase 2: HTML Image Extraction

**2.1 Create Content Parser Utility**
```typescript
// src/utils/article-helpers.ts

import { JSDOM } from 'jsdom';

export function extractImagesFromArticle(htmlContent: string): {
  url: string;
  alt?: string;
}[] {
  const dom = new JSDOM(htmlContent);
  const images = Array.from(dom.window.document.querySelectorAll('img'));

  return images
    .map(img => ({
      url: img.src,
      alt: img.alt || undefined,
    }))
    .filter(img => img.url.includes('civitai.com') || img.url.includes('wasabisys.com'));
}

export function isImageScanned(imageUrl: string): Promise<boolean> {
  // Check if Image entity exists and is scanned
  const image = await db.image.findFirst({
    where: { url: imageUrl },
    select: { ingestion: true }
  });

  return image?.ingestion === ImageIngestionStatus.Scanned;
}
```

### Phase 3: Image Upload Integration

**🔴 REVISED APPROACH: Create Images on Save, Not Upload**

> **Why the change?**: Users frequently upload images then delete them during editing. Creating Image entities immediately causes database pollution with orphaned records. Instead, track URLs in editor state and create entities only on article save.

**3.1 Rich Text Editor Upload Handler (REVISED)**
```typescript
// src/components/RichTextEditor/image-upload-handler.ts

async function handleArticleImageUpload(file: File) {
  // 1. Upload to S3/CloudFlare ONLY
  const url = await uploadToS3(file);

  // 2. Return URL to editor (no DB operations yet)
  // Image entity will be created when article is saved
  return url;
}
```

**3.2 Article Save Handler (NEW)**
```typescript
// src/components/Article/ArticleUpsertForm.tsx

const handleSubmit = async (data) => {
  // 1. Extract images from final HTML content
  const contentImages = extractImagesFromArticle(data.content);

  // 2. Batch query for existing images
  const imageUrls = contentImages.map(img => img.url);
  const existingImages = await db.image.findMany({
    where: { url: { in: imageUrls } },
    select: { id: true, url: true, ingestion: true }
  });

  const existingUrlMap = new Map(existingImages.map(img => [img.url, img]));

  // 3. Create missing Image entities in single transaction
  const missingUrls = imageUrls.filter(url => !existingUrlMap.has(url));

  if (missingUrls.length > 0) {
    const newImages = await db.image.createMany({
      data: missingUrls.map(url => ({
        url,
        userId: currentUser.id,
        type: MediaType.image,
        ingestion: ImageIngestionStatus.Pending,
        scanRequestedAt: new Date(),
      })),
      skipDuplicates: true, // Handle race conditions
    });
  }

  // 4. Check if all images are scanned
  const allImages = await db.image.findMany({
    where: { url: { in: imageUrls } },
    select: { url: true, ingestion: true }
  });

  const allScanned = allImages.every(img => img.ingestion === 'Scanned');

  // 5. Set article status based on scan state
  const articleStatus = data.publishedAt && !allScanned
    ? ArticleStatus.Processing
    : data.status;

  // 6. Save article with computed status
  const article = await upsertArticle({
    ...data,
    status: articleStatus,
  });

  return article;
};
```

**3.2 Update Existing Content Images** (Migration)
```typescript
// scripts/migrate-article-images.ts

async function migrateArticleContentImages() {
  const articles = await db.article.findMany({
    where: { status: ArticleStatus.Published },
    select: { id: true, content: true }
  });

  for (const article of articles) {
    const imageUrls = extractImagesFromArticle(article.content);

    for (const { url } of imageUrls) {
      // Find or create Image entity
      let image = await db.image.findFirst({ where: { url } });

      if (!image) {
        image = await db.image.create({
          data: {
            url,
            userId: article.userId,
            type: MediaType.image,
            ingestion: ImageIngestionStatus.Pending,
          }
        });
      }

      // Create ImageConnection
      await db.imageConnection.upsert({
        where: {
          imageId_entityType_entityId: {
            imageId: image.id,
            entityType: 'Article',
            entityId: article.id,
          }
        },
        create: { imageId: image.id, entityType: 'Article', entityId: article.id },
        update: {},
      });
    }
  }
}
```

### Phase 4: Scan Coordination

**4.1 Update Image Scan Webhook**
```typescript
// src/pages/api/webhooks/image-scan-result.ts

async function updateImage(image, result) {
  await dbWrite.image.update({ where: { id }, data });

  if (data.ingestion === 'Scanned') {
    // Existing logic
    if (image.postId) await updatePostNsfwLevel(image.postId);

    // NEW: Update connected articles
    const articleConnections = await db.imageConnection.findMany({
      where: {
        imageId: image.id,
        entityType: 'Article',
      },
      select: { entityId: true }
    });

    if (articleConnections.length > 0) {
      const articleIds = articleConnections.map(c => c.entityId);
      await updateArticleImageScanStatus(articleIds);
    }
  }
}
```

**4.2 Create Article Scan Status Updater (WITH LOCKING)**
```typescript
// src/server/services/article.service.ts

/**
 * 🔴 CRITICAL: Uses PostgreSQL advisory locks to prevent race conditions
 * from concurrent webhook calls for same article
 */
export async function updateArticleImageScanStatus(articleIds: number[]) {
  for (const articleId of articleIds) {
    await dbWrite.$transaction(async (tx) => {
      // 🔒 Acquire advisory lock for this article (prevents concurrent webhooks)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

      // Get all connected images
      const connections = await tx.imageConnection.findMany({
        where: {
          entityId: articleId,
          entityType: 'Article',
        },
        include: { image: { select: { ingestion: true, nsfwLevel: true } } }
      });

      const totalImages = connections.length;
      const scannedImages = connections.filter(
        c => c.image.ingestion === ImageIngestionStatus.Scanned
      ).length;
      const blockedImages = connections.filter(
        c => c.image.ingestion === ImageIngestionStatus.Blocked
      ).length;
      const errorImages = connections.filter(
        c => [ImageIngestionStatus.Error, ImageIngestionStatus.NotFound].includes(c.image.ingestion)
      ).length;

      // Treat errors as "complete" so article can publish
      const completedImages = scannedImages + blockedImages + errorImages;
      const allComplete = completedImages === totalImages;

      if (allComplete) {
        // Update article NSFW level based on ALL images
        await updateArticleNsfwLevels([articleId]);

        // Change status from Processing → Published
        const article = await tx.article.findUnique({
          where: { id: articleId },
          select: { status: true, publishedAt: true, userId: true }
        });

        if (article.status === ArticleStatus.Processing && article.publishedAt) {
          await tx.article.update({
            where: { id: articleId },
            data: { status: ArticleStatus.Published }
          });

          // Notify user if there were errors/blocked images
          if (blockedImages > 0 || errorImages > 0) {
            await createNotification({
              userId: article.userId,
              type: 'article-images-failed',
              details: {
                articleId,
                blockedCount: blockedImages,
                errorCount: errorImages,
              },
            });
          }
        }
      }

      // ⚠️ Don't store derived state in metadata - causes inconsistency
      // UI should query ImageConnection directly for real-time status
    }, {
      timeout: 30000, // 30s timeout
    });
  }
}
```

**4.3 Update Article NSFW Level Calculation (OPTIMIZED)**
```typescript
// src/server/services/nsfwLevels.service.ts

/**
 * 🔴 OPTIMIZED: Only includes SCANNED images, uses proper JOIN strategy
 *
 * ⚠️ IMPORTANT: Uses bit_or() because NSFW levels are BITWISE FLAGS
 * Example: Soft=1, Mature=2, X=4 → bit_or(1,2) = 3 (Soft|Mature)
 * This combines all NSFW flags from cover + content images
 */
export async function updateArticleNsfwLevels(articleIds: number[]) {
  const articles = await dbWrite.$queryRaw`
    WITH level AS (
      SELECT
        a.id,
        bit_or(COALESCE(cover."nsfwLevel", 0)) |
        bit_or(COALESCE(content_imgs."nsfwLevel", 0)) AS "nsfwLevel"
      FROM "Article" a

      -- Cover image (left join - may not exist)
      LEFT JOIN "Image" cover
        ON a."coverId" = cover.id
        AND cover."ingestion" = 'Scanned'  -- ✅ Only scanned images

      -- Content images (left join - may not exist)
      LEFT JOIN "ImageConnection" ic
        ON ic."entityId" = a.id
        AND ic."entityType" = 'Article'
      LEFT JOIN "Image" content_imgs
        ON ic."imageId" = content_imgs.id
        AND content_imgs."ingestion" = 'Scanned'  -- ✅ Only scanned images

      WHERE a.id = ANY(${articleIds}::int[])  -- Better performance than IN
      GROUP BY a.id
    )
    UPDATE "Article" a
    SET "nsfwLevel" = GREATEST(a."userNsfwLevel", level."nsfwLevel")
    FROM level
    WHERE level.id = a.id
      AND level."nsfwLevel" != a."nsfwLevel"  -- Only update if changed
    RETURNING a.id;
  `;

  await articlesSearchIndex.queueUpdate(
    articles.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}
```

### Phase 5: Article Publishing Logic

**5.1 Update Upsert Article**
```typescript
// src/server/services/article.service.ts

upsertArticle = async ({ content, ...data }) => {
  // Create/update article first
  const article = await dbWrite.article.upsert({ ... });

  // Extract images from content
  const contentImages = extractImagesFromArticle(content || '');

  // ✅ OPTIMIZATION: Only process if article has embedded images
  // Articles without embedded images rely on cover image + userNsfwLevel only
  if (contentImages.length > 0) {
    // Link content images
    for (const { url } of contentImages) {
      let image = await db.image.findFirst({ where: { url } });

      if (!image) {
        // Create Image entity for existing URLs (migration scenario)
        image = await createImage({ url, userId });
      }

      await db.imageConnection.upsert({
        where: {
          imageId_entityType_entityId: {
            imageId: image.id,
            entityType: 'Article',
            entityId: article.id,
          }
        },
        create: { imageId: image.id, entityType: 'Article', entityId: article.id },
        update: {},
      });
    }

    // Check if any images are unscanned
    const unscannedImages = [];
    for (const { url } of contentImages) {
      const image = await db.image.findFirst({ where: { url } });
      if (!image || image.ingestion === ImageIngestionStatus.Pending) {
        unscannedImages.push(url);
      }
    }

    // Force Processing status if publishing with unscanned images
    if (data.publishedAt && unscannedImages.length > 0) {
      await dbWrite.article.update({
        where: { id: article.id },
        data: { status: ArticleStatus.Processing }
      });
    }
  }
  // If no content images, article publishes immediately using cover + userNsfwLevel

  return article;
};
```

---

## 📋 Implementation Checklist

### Database & Schema
- [x] Add `Processing` to `ArticleStatus` enum
- [x] Migration: Add enum value to database
- [x] Update Prisma schema
- [x] Generate new Prisma client

### Utilities
- [ ] Create `src/utils/article-helpers.ts`
  - [ ] `extractImagesFromArticle()`
  - [ ] `getArticleImageScanStatus()`
- [ ] Add unit tests for HTML parsing

### Services
- [ ] Update `src/server/services/nsfwLevels.service.ts`
  - [ ] Modify `updateArticleNsfwLevels()` to include content images
- [ ] Update `src/server/services/article.service.ts`
  - [ ] Add `updateArticleImageScanStatus()`
  - [ ] Modify `upsertArticle()` for image linking
  - [ ] Add `linkArticleContentImages()`

### Webhooks
- [ ] Update `src/pages/api/webhooks/image-scan-result.ts`
  - [ ] Add article update logic to `updateImage()`
  - [ ] Call `updateArticleImageScanStatus()`

### UI Components
- [ ] Add scan status indicator to article editor
  - [ ] Show "X of Y images scanned"
  - [ ] Warning when publishing with unscanned images
- [ ] Add article status badges
  - [ ] "Pending Review" badge
  - [ ] Tooltip explaining scan wait

### Migration
- [ ] Create `scripts/migrate-article-images.ts`
  - [ ] Extract images from existing articles
  - [ ] Create Image entities
  - [ ] Create ImageConnections
  - [ ] Trigger scans for unscanned images
- [ ] Run migration on staging
- [ ] Validate results
- [ ] Run migration on production

### Testing
- [ ] Unit tests for article image extraction
- [ ] Integration tests for scan coordination
- [ ] E2E tests for article publishing flow
- [ ] Load testing for bulk image scanning

---

## 🎯 Success Criteria

**Functional Requirements**:
- ✅ All article content images tracked in database
- ✅ Articles remain hidden until all images scanned
- ✅ Article NSFW level reflects ALL images (cover + content)
- ✅ Automatic transition from Processing → Published
- ✅ Graceful handling of scan failures

**Performance Requirements**:
- Image extraction: <100ms for typical article
- Scan status check: <50ms (indexed query)
- Batch updates: Handle 1000+ articles efficiently

**Data Integrity**:
- No orphaned ImageConnections
- No articles with broken image references
- Consistent NSFW levels across all images

---

## 🚨 Risks & Mitigations

### Risk 1: Migration Performance
**Problem**: Millions of existing article images to process
**Mitigation**:
- Batch processing (100 articles at a time)
- Queue-based migration (background job)
- Prioritize recent/published articles

### Risk 2: Scan Delays
**Problem**: Users frustrated by publish delays
**Mitigation**:
- Clear UI messaging about scan status
- Email notification when article published
- Draft mode for immediate saving

### Risk 3: External Image URLs
**Problem**: Images hosted outside Civitai
**Mitigation**:
- Filter to only Civitai domains
- Allow manual override for trusted sources
- Proxy external images through CDN

---

## 📊 Implementation Timeline

> **⚠️ REVISED TO 4 WEEKS** to address critical architectural issues identified in review.

**Week 1**: Database Foundations & Critical Fixes
- Schema changes (Processing status, indexes, unique constraints)
- Advisory lock implementation
- Webhook debouncing/queue setup
- Migration transaction safety
- Feature flag setup in existing feature-flags.service.ts

**Week 2**: Core Services & Integration
- Core utility functions (extractImagesFromArticle with optimization)
- Service layer updates with locking
- Article save-time image creation (not upload-time)
- Feature flag integration in article workflows

**Week 3**: UI Components & Real-Time Updates
- tRPC polling/subscriptions for scan status
- Error recovery UI (blocked/failed images)
- Article scan status components
- Accessibility improvements
- Feature flag-gated UI components

**Week 4**: Testing, Migration & Rollout
- Unit tests (race conditions, concurrency)
- Integration tests (webhook flow, error scenarios)
- Migration script with transaction safety
- Staging deployment and validation
- Production migration execution (feature flag: OFF)
- Enable feature flag for production rollout
- Monitoring dashboards

---

## 🔗 Related Files

**Schema**:
- [prisma/schema.prisma:2359](/Users/hackstreetboy/Projects/civitai/prisma/schema.prisma#L2359) - Article model
- [prisma/schema.prisma:1362](/Users/hackstreetboy/Projects/civitai/prisma/schema.prisma#L1362) - Image model
- [prisma/schema.prisma:1468](/Users/hackstreetboy/Projects/civitai/prisma/schema.prisma#L1468) - ImageConnection model

**Services**:
- [src/server/services/article.service.ts:668](/Users/hackstreetboy/Projects/civitai/src/server/services/article.service.ts#L668) - Article upsert
- [src/server/services/nsfwLevels.service.ts:257](/Users/hackstreetboy/Projects/civitai/src/server/services/nsfwLevels.service.ts#L257) - Article NSFW update
- [src/server/services/image.service.ts:4937](/Users/hackstreetboy/Projects/civitai/src/server/services/image.service.ts#L4937) - Image ingestion

**Webhooks**:
- [src/pages/api/webhooks/image-scan-result.ts](/Users/hackstreetboy/Projects/civitai/src/pages/api/webhooks/image-scan-result.ts) - Image scan handler

**Components**:
- [src/components/RichTextEditor/RichTextEditorComponent.tsx](/Users/hackstreetboy/Projects/civitai/src/components/RichTextEditor/RichTextEditorComponent.tsx) - Rich text editor

---

**Analysis Completed**: 2025-10-06
**Next Steps**: Review with team, prioritize implementation phases, create GitHub issues


## Before release
- [ ] Add index on ImageConnection in prod
- [ ] Test all possible scenarios
- [ ] Put everything behind feature flag
- [x] Send article notification after scan results
- [ ] Show problematic images on article
