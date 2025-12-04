# Image Feed createDocuments Implementation Plan

**Date**: 2025-11-04
**Status**: Planning / Analysis Complete

## Overview

Implement and test the `createDocuments` function for ImagesFeed, which builds Meilisearch documents from data pulled from PostgreSQL, ClickHouse, and Redis caches. The goal is to replicate the document creation logic from `metrics-images.search-index.ts` within the event-engine-common feed framework.

## Current State Analysis

### ✅ Already Implemented

The `createDocuments` function **is already implemented** in `event-engine-common/feeds/images.feed.ts` (lines 135-344).

**Implementation includes:**

1. **Metrics-only updates** (lightweight, line 141-157)
   - Only fetches and updates metric fields (reactions, comments, collections)
   - Used for frequent metric updates without full document rebuilds

2. **Full document creation** (line 159-344)
   - Fetches base image data from PostgreSQL (sortAt, NSFW levels, metadata)
   - Fetches metrics from ClickHouse via MetricService
   - Fetches tags from Redis cache via CacheService
   - Fetches tools and techniques from PostgreSQL
   - Fetches model versions and base models from PostgreSQL
   - Transforms and combines all data into `ImageDocument` format

### Data Sources

| Source | Data Fetched | Method |
|--------|-------------|---------|
| PostgreSQL | Base image data, tools, techniques, model versions | `ctx.pg.query()` |
| ClickHouse | Metrics (reactions, comments, collections) | `ctx.metric.fetch()` |
| Redis Cache | Tag IDs | `ctx.cache.fetch('imageTagIds')` |

### Document Fields

The `ImageDocument` type includes:

**Identity & Basic Info:**
- id, index, postId, userId, url, hash, width, height, type

**Dates & Sorting:**
- sortAt, sortAtUnix, publishedAt, publishedAtUnix, existedAtUnix

**NSFW & Safety:**
- nsfwLevel, aiNsfwLevel, combinedNsfwLevel, poi, minor, acceptableMinor, blockedFor, availability

**Content & Metadata:**
- hasMeta, hasPositivePrompt, hideMeta, onSite, needsReview

**Resources:**
- baseModel, modelVersionIds, modelVersionIdsManual, postedToId, toolIds, techniqueIds, tagIds

**Metrics:**
- reactionCount, commentCount, collectedCount

**Flags:**
- flags.promptNsfw

**Relationships:**
- remixOfId

## Comparison with metrics-images.search-index.ts

### Similarities ✅
Both implementations:
- Fetch the same base image data with identical SQL queries
- Use the same metrics aggregation logic
- Fetch tags from the same cache
- Fetch tools, techniques, and model versions identically
- Apply the same transformations (combinedNsfwLevel, flags, etc.)
- Generate documents with the same structure

### Differences

| Aspect | metrics-images.search-index.ts | ImagesFeed createDocuments |
|--------|-------------------------------|---------------------------|
| **Framework** | `createSearchIndexUpdateProcessor` | `createFeed` |
| **Batching** | Multi-step pull with `pullSteps: 5` | Single loop with chunking |
| **Data Flow** | Accumulates data across steps in `prevData` | Fetches all data per batch |
| **Metrics** | Direct ClickHouse query | Via `MetricService` abstraction |
| **Tags** | Via `tagIdsForImagesCache.fetch()` | Via `CacheService.fetch('imageTagIds')` |
| **Push** | Uses `updateDocs()` helper | Uses `feed.upsert()` method |

### Architecture Advantage

The feed implementation is **cleaner and more maintainable**:
- Single cohesive function vs. multi-step processor
- Dependency injection via FeedContext
- Type-safe throughout
- Easier to test (no processor setup needed)

## Testing Strategy

### Goals

1. **Verify document structure** matches expected schema
2. **Compare output** with `metrics-images.search-index.ts` for same input IDs
3. **Mock data sources** to avoid hitting real databases
4. **Test both update types** (full and metrics-only)

### Testing Approach

#### 1. Mock Context Setup

Create a test helper that mocks `FeedContext`:

```typescript
// test/helpers/mock-feed-context.ts

export function createMockFeedContext(
  mockData: {
    images?: SearchBaseImage[];
    metrics?: Record<number, ImageMetrics>;
    tags?: Record<number, { tags: number[] }>;
    tools?: ImageToolData[];
    techniques?: ImageTechniqueData[];
    modelVersions?: ModelVersionData[];
  }
): FeedContext<'Image'> {
  return {
    pg: {
      query: async <T>(query: string, params?: any[]): Promise<T[]> => {
        // Parse query to determine what data to return
        if (query.includes('FROM "Image"')) return mockData.images as T[];
        if (query.includes('FROM "ImageTool"')) return mockData.tools as T[];
        if (query.includes('FROM "ImageTechnique"')) return mockData.techniques as T[];
        if (query.includes('FROM "ImageResourceNew"')) return mockData.modelVersions as T[];
        return [];
      },
    },
    ch: {
      query: async () => [],
    },
    cache: {
      fetch: async (name: string, ids: number[]) => {
        if (name === 'imageTagIds') return mockData.tags ?? {};
        return {};
      },
      mGet: async () => [],
      set: async () => {},
      sAdd: async () => {},
    },
    metric: {
      fetch: async (ids: number[]) => mockData.metrics ?? {},
    },
    index: {} as any,
    pagination: { limit: 20, cursor: undefined },
  };
}
```

#### 2. Unit Tests

```typescript
// test/feeds/images.feed.createDocuments.test.ts

import { createDocuments } from '../../event-engine-common/feeds/images.feed';
import { createMockFeedContext } from '../helpers/mock-feed-context';

describe('ImagesFeed.createDocuments', () => {
  describe('metrics-only updates', () => {
    it('should create partial documents with only metrics', async () => {
      const ctx = createMockFeedContext({
        metrics: {
          1: { ReactionHeart: 10, ReactionLike: 5, Comment: 3, Collection: 2 },
          2: { ReactionHeart: 20, Comment: 1 },
        },
      });

      const docs = await createDocuments(ctx, [1, 2], 'metrics');

      expect(docs).toHaveLength(2);
      expect(docs[0]).toEqual({
        id: 1,
        reactionCount: 15, // 10 + 5
        commentCount: 3,
        collectedCount: 2,
      });
      expect(docs[1]).toEqual({
        id: 2,
        reactionCount: 20,
        commentCount: 1,
        collectedCount: 0,
      });
    });
  });

  describe('full document creation', () => {
    it('should create complete documents with all data sources', async () => {
      const mockImage: SearchBaseImage = {
        id: 1,
        index: 0,
        postId: 100,
        url: 'https://example.com/image.jpg',
        nsfwLevel: 1,
        aiNsfwLevel: 2,
        nsfwLevelLocked: false,
        width: 1024,
        height: 768,
        hash: 'abc123',
        hideMeta: false,
        sortAt: new Date('2024-01-01'),
        type: 'image',
        userId: 50,
        publishedAt: new Date('2024-01-01'),
        hasMeta: true,
        onSite: true,
        postedToId: 200,
        needsReview: null,
        minor: false,
        promptNsfw: false,
        blockedFor: null,
        remixOfId: null,
        hasPositivePrompt: true,
        availability: 'Public',
        poi: false,
        acceptableMinor: false,
      };

      const ctx = createMockFeedContext({
        images: [mockImage],
        metrics: {
          1: { ReactionHeart: 10, Comment: 5, Collection: 2 },
        },
        tags: {
          1: { tags: [1, 2, 3] },
        },
        tools: [
          { imageId: 1, toolId: 10 },
          { imageId: 1, toolId: 11 },
        ],
        techniques: [
          { imageId: 1, techniqueId: 20 },
        ],
        modelVersions: [
          {
            id: 1,
            baseModel: 'SD 1.5',
            modelVersionIdsAuto: [200, 201],
            modelVersionIdsManual: [202],
            poi: false,
          },
        ],
      });

      const docs = await createDocuments(ctx, [1], 'full');

      expect(docs).toHaveLength(1);
      const doc = docs[0];

      // Verify all fields are populated
      expect(doc.id).toBe(1);
      expect(doc.baseModel).toBe('SD 1.5');
      expect(doc.modelVersionIds).toEqual([200, 201]);
      expect(doc.modelVersionIdsManual).toEqual([202]);
      expect(doc.toolIds).toEqual([10, 11]);
      expect(doc.techniqueIds).toEqual([20]);
      expect(doc.tagIds).toEqual([1, 2, 3]);
      expect(doc.reactionCount).toBe(10);
      expect(doc.commentCount).toBe(5);
      expect(doc.collectedCount).toBe(2);
      expect(doc.combinedNsfwLevel).toBe(2); // max(1, 2)
      expect(doc.sortAtUnix).toBe(new Date('2024-01-01').getTime());
    });

    it('should handle missing optional data gracefully', async () => {
      const minimalImage: SearchBaseImage = {
        id: 2,
        index: 0,
        postId: 101,
        url: 'https://example.com/image2.jpg',
        nsfwLevel: 1,
        aiNsfwLevel: 0,
        nsfwLevelLocked: true,
        width: 512,
        height: 512,
        hash: 'def456',
        hideMeta: true,
        sortAt: new Date('2024-01-02'),
        type: 'image',
        userId: 51,
        publishedAt: undefined,
        hasMeta: false,
        onSite: false,
        postedToId: undefined,
        needsReview: null,
        minor: false,
        promptNsfw: false,
        blockedFor: null,
        remixOfId: null,
        hasPositivePrompt: false,
        availability: 'Public',
        poi: false,
        acceptableMinor: false,
      };

      const ctx = createMockFeedContext({
        images: [minimalImage],
        metrics: {}, // No metrics
        tags: {}, // No tags
        tools: [], // No tools
        techniques: [], // No techniques
        modelVersions: [], // No model versions
      });

      const docs = await createDocuments(ctx, [2], 'full');

      expect(docs).toHaveLength(1);
      const doc = docs[0];

      expect(doc.id).toBe(2);
      expect(doc.baseModel).toBe('');
      expect(doc.modelVersionIds).toEqual([]);
      expect(doc.toolIds).toEqual([]);
      expect(doc.tagIds).toEqual([]);
      expect(doc.reactionCount).toBe(0);
      expect(doc.commentCount).toBe(0);
      expect(doc.collectedCount).toBe(0);
      expect(doc.combinedNsfwLevel).toBe(1); // locked at nsfwLevel
    });
  });

  describe('batching', () => {
    it('should handle large ID lists with batching', async () => {
      const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
      const images = ids.map(id => ({
        id,
        // ... minimal image data
      }));

      const ctx = createMockFeedContext({ images });

      const docs = await createDocuments(ctx, ids, 'full');

      expect(docs.length).toBe(2500);
      // Verify batching happened (3 batches of 1000)
      // This is implicit - the function should complete without errors
    });
  });
});
```

#### 3. Integration Tests (Compare with Legacy)

```typescript
// test/integration/feed-vs-legacy.test.ts

import { createDocuments } from '../../event-engine-common/feeds/images.feed';
import { transformData } from '../../src/server/search-index/metrics-images.search-index';

describe('ImagesFeed vs Legacy Implementation', () => {
  it('should produce identical documents for same input', async () => {
    // Use real database connections (test database)
    const testIds = [1, 2, 3]; // Known test image IDs

    // Get documents from new implementation
    const feedDocs = await createDocuments(realFeedContext, testIds, 'full');

    // Get documents from legacy implementation
    const legacyDocs = await getLegacyDocuments(testIds); // Helper function

    // Compare documents (excluding timestamps that might differ slightly)
    for (let i = 0; i < testIds.length; i++) {
      expect(feedDocs[i]).toMatchObject({
        id: legacyDocs[i].id,
        baseModel: legacyDocs[i].baseModel,
        modelVersionIds: legacyDocs[i].modelVersionIds,
        nsfwLevel: legacyDocs[i].nsfwLevel,
        // ... all fields except existedAtUnix
      });
    }
  });
});
```

#### 4. Document Generation CLI Tool

Create a script to generate documents without pushing to Meilisearch:

```typescript
// scripts/generate-feed-documents.ts

import { ImagesFeed } from '../event-engine-common/feeds';
import { MetricService } from '../event-engine-common/services/metrics';
import { CacheService } from '../event-engine-common/services/cache';
import { writeFileSync } from 'fs';

async function generateDocuments(imageIds: number[]) {
  const feed = new ImagesFeed(
    metricsSearchClient,
    clickhouse,
    pgDbWrite,
    new MetricService(clickhouse, redis),
    new CacheService(redis, pgDbWrite, clickhouse)
  );

  // Call createDocuments directly (bypasses upsert/Meilisearch)
  const docs = await feed['context'].createDocuments(feed['context'], imageIds, 'full');

  // Write to JSON for inspection
  writeFileSync(
    `./test-data/feed-documents-${Date.now()}.json`,
    JSON.stringify(docs, null, 2)
  );

  console.log(`Generated ${docs.length} documents`);
  console.log('Sample document:', docs[0]);
}

// Usage: npm run generate-docs -- 1,2,3,4,5
const ids = process.argv[2]?.split(',').map(Number) ?? [];
generateDocuments(ids);
```

### Testing Workflow

1. **Unit Tests** - Run with mocked data
   ```bash
   npm test -- images.feed.createDocuments.test.ts
   ```

2. **Generate Documents** - Test with real data (no Meilisearch push)
   ```bash
   npm run generate-docs -- 1,2,3,4,5
   ```

3. **Compare Documents** - Verify against legacy implementation
   ```bash
   npm run compare-docs -- 1,2,3,4,5
   ```

4. **Integration Test** - Full flow with test database
   ```bash
   npm test:integration -- feed-vs-legacy.test.ts
   ```

## Implementation Tasks

### ✅ Already Complete
- [x] `createDocuments` function implemented
- [x] Schema defined and matches legacy
- [x] All data sources integrated (PG, CH, Redis)
- [x] Metrics-only update mode
- [x] Full document creation mode
- [x] Batching logic (1000 IDs per batch)

### 🔲 Testing Tasks (To Do)

1. [ ] Create mock FeedContext helper
2. [ ] Write unit tests for metrics-only updates
3. [ ] Write unit tests for full document creation
4. [ ] Write unit tests for edge cases (missing data, empty results)
5. [ ] Create document generation CLI script
6. [ ] Write comparison script (feed vs legacy)
7. [ ] Run integration tests on test database
8. [ ] Document test results and any discrepancies

### 🔲 Optional Enhancements

1. [ ] Add performance benchmarks (feed vs legacy)
2. [ ] Add document validation (Zod schema)
3. [ ] Add logging/metrics for document creation
4. [ ] Add retry logic for transient failures
5. [ ] Add caching for frequently accessed model versions

## Next Steps

1. **Create test infrastructure** (mock helpers, test database setup)
2. **Write and run unit tests** to verify correctness
3. **Generate sample documents** from production-like data
4. **Compare with legacy** to ensure parity
5. **Document any differences** and get approval
6. **Create migration plan** for switching from legacy to feed

## Questions / Decisions

1. **Test database**: Should we use a separate test database or mock everything?
   - Recommendation: Mock for unit tests, real DB for integration tests

2. **Legacy comparison**: Should we maintain 100% parity or allow minor improvements?
   - Recommendation: 100% parity initially, document improvements separately

3. **Performance targets**: What are acceptable document creation times?
   - Current: ~1-2 seconds per 1000 IDs (legacy)
   - Target: Match or beat legacy performance

4. **Error handling**: How should we handle partial failures (some IDs succeed, some fail)?
   - Recommendation: Log errors but continue processing remaining IDs

5. **Monitoring**: What metrics should we track for document creation?
   - Documents created per minute
   - Average creation time per document
   - Error rate
   - Cache hit rate for tags

---

**Status**: Ready for testing implementation
**Next Action**: Create mock helpers and write first unit test
