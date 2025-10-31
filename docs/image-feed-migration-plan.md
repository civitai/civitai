# Image Feed Migration Plan

## Overview
Migrate `getImagesFromSearchPostFilter` functionality to use the new `event-engine-common` Feed system. This will provide a unified, type-safe interface for querying, populating, and creating image documents in Meilisearch.

This migration also includes migrating the Meilisearch population job (`metrics-images.search-index.ts`) to use the same Feed system's `createDocuments` method.

## Current Implementation Analysis

### 1. `getImagesFromSearchPostFilter` (src/server/services/image.service.ts:2371)
**Responsibilities:**
- Queries Meilisearch with complex filters
- Post-processes results (existence checks, permission filtering)
- Populates with metrics from ClickHouse
- Returns paginated results with cursor

**Key Features:**
- Adaptive batch sizing for post-filtering
- Feature-flagged existence checking (Redis cache + DB fallback)
- NSFW level filtering (browsing levels)
- Complex permission filtering (private/blocked content, scheduled posts)
- Period-based filtering
- Tag/tool/technique filtering
- Model version filtering (auto/manual resources)
- Remix filtering
- POI/minor content filtering
- Moderator-specific features

### 2. `metrics-images.search-index.ts` (src/server/search-index/metrics-images.search-index.ts)
**Responsibilities:**
- Fetches base image data from PostgreSQL
- Fetches metrics from ClickHouse
- Fetches tags, tools, techniques, and model versions
- Transforms and combines all data for Meilisearch indexing

**Document Structure:**
```typescript
{
  id, index, postId, url, nsfwLevel, aiNsfwLevel, nsfwLevelLocked,
  width, height, hash, hideMeta, sortAt, type, userId, publishedAt,
  hasMeta, onSite, postedToId, needsReview, minor, promptNsfw,
  blockedFor, remixOfId, hasPositivePrompt, availability, poi,
  acceptableMinor,
  // Transformed:
  combinedNsfwLevel, baseModel, modelVersionIds, modelVersionIdsManual,
  toolIds, techniqueIds, publishedAtUnix, existedAtUnix, sortAtUnix,
  tagIds, flags, reactionCount, commentCount, collectedCount
}
```

## Required Types to Port

### From Civitai Main Codebase
1. **Enums:**
   - `ImageSort` - sorting options
   - `NsfwLevel` - NSFW content levels
   - `Availability` - content availability (Public, Private, etc.)
   - `BlockedReason` - reasons for blocking content
   - `MediaType` - image/video types

2. **Input Types:**
   - `ImageSearchInput` - complete filter/query input
   - Derived from `GetInfiniteImagesOutput` + additional fields

3. **Document Types:**
   - `ImageMetricsSearchIndexRecord` - Meilisearch document structure
   - `SearchBaseImage` - base image data from PostgreSQL

4. **Helper Types:**
   - Browsing level flags/arrays
   - NSFW restricted base models

## Implementation Plan

### Phase 1: Type Definitions
**File:** `event-engine-common/types/image-feed-types.ts`

Port necessary types and enums that don't already exist in event-engine-common:
- Image search input filters
- Image sort options
- NSFW/availability enums
- Document types

### Phase 2: Schema Definition
**File:** `event-engine-common/feeds/image.feed.ts`

Define comprehensive schema matching the current Meilisearch index:
```typescript
const schema = {
  // Primary
  id: { type: 'number', primary: true, filterable: true },

  // Basic fields
  sortAt: { type: 'Date', sortable: true },
  sortAtUnix: { type: 'number', filterable: true },
  type: { type: 'string', filterable: true },
  userId: { type: 'number', filterable: true },
  postId: { type: 'number', filterable: true },

  // Model/Resource fields
  modelVersionIds: { type: 'array', arrayType: 'number', filterable: true },
  modelVersionIdsManual: { type: 'array', arrayType: 'number', filterable: true },
  postedToId: { type: 'number', filterable: true },
  baseModel: { type: 'string', filterable: true },

  // NSFW/Content Safety
  nsfwLevel: { type: 'number', filterable: true },
  combinedNsfwLevel: { type: 'number', filterable: true },
  availability: { type: 'string', filterable: true },
  blockedFor: { type: 'string', filterable: true },
  poi: { type: 'boolean', filterable: true },
  minor: { type: 'boolean', filterable: true },

  // Tags/Tools/Techniques
  tagIds: { type: 'array', arrayType: 'number', filterable: true },
  toolIds: { type: 'array', arrayType: 'number', filterable: true },
  techniqueIds: { type: 'array', arrayType: 'number', filterable: true },

  // Metadata
  hasMeta: { type: 'boolean', filterable: true },
  onSite: { type: 'boolean', filterable: true },
  publishedAtUnix: { type: 'number', filterable: true },
  existedAtUnix: { type: 'number', filterable: true },
  remixOfId: { type: 'number', filterable: true },

  // Flags
  'flags.promptNsfw': { type: 'boolean', filterable: true },

  // Metrics
  reactionCount: { type: 'number', sortable: true },
  commentCount: { type: 'number', sortable: true },
  collectedCount: { type: 'number', sortable: true },
} as const;
```

### Phase 3: createDocuments Implementation

Replicate the logic from `metrics-images.search-index.ts`:

1. **Fetch base image data** from PostgreSQL (similar to pullData step 0)
2. **Fetch metrics** from ClickHouse (step 1)
3. **Fetch tags** from cache (step 2)
4. **Fetch tools/techniques** from PostgreSQL (step 3)
5. **Fetch model versions** from PostgreSQL (step 4)
6. **Transform and combine** all data (transformData function)

Key considerations:
- Handle both 'full' and 'metrics' update types
- Use batching for large ID sets
- Proper error handling

### Phase 4: queryDocuments Implementation

Replicate filter logic from `getImagesFromSearchPostFilter`:

1. **Build Meilisearch filters:**
   - NSFW level filtering (browsingLevel → combinedNsfwLevel/nsfwLevel)
   - NSFW license restrictions (restricted base models)
   - Model version filtering (postedToId, modelVersionIds, modelVersionIdsManual)
   - Remix filtering (remixOfId, remixesOnly, nonRemixesOnly)
   - Tag/tool/technique filtering
   - Type filtering
   - Period filtering (sortAtUnix)
   - User filtering (userId, excludedUserIds, followed, hidden)
   - POI/minor filtering
   - Metadata filtering (hasMeta, onSite, requiringMeta)
   - Publishing status filtering (publishedAtUnix)
   - Moderator features (blockedFor, scheduled, notPublished)

2. **Build sort orders:**
   - Map ImageSort enum to Meilisearch sorts
   - Add secondary sort by ID for consistency

3. **Handle pagination:**
   - Use cursor from context
   - Return results matching limit

**Note:** Post-filtering logic (existence checks, permission validation) will be handled in populateDocuments.

### Phase 5: populateDocuments Implementation

Enhance documents with additional data:

1. **Fetch image metrics** from cache (imageMetricsCache)
2. **Build stats object** with all-time counts:
   - likeCountAllTime, heartCountAllTime, etc.
   - commentCountAllTime, collectedCountAllTime
   - tippedAmountCountAllTime

3. **Required enhancements:**
   - User data (username, profile pictures)
   - Tag names
   - Resource details
   - Cosmetics

4. **Post-filtering logic:**
   - Existence checks (via Redis cache + DB fallback)
   - Permission validation (private/blocked content)
   - Scheduled post filtering (for non-owners)
   - NSFW level validation (unscanned content)

**Return Type:**
Populated image with all necessary data for display in the feed.

### Phase 6: Integration & Testing

1. **Export Feed class:**
```typescript
export const ImageFeed = createFeed({
  entityType: 'Image',
  name: 'metrics-images',
  schema,
  createDocuments,
  queryDocuments,
  populateDocuments,
});
```

2. **Test scenarios:**
   - Basic queries with various filters
   - Pagination
   - Document creation/updates
   - Performance benchmarking vs current implementation

## Key Differences from Current Sample

The existing `event-engine-common/feeds/image.feed.ts` is a simple example. The new implementation will:

1. **Much larger schema** - 30+ fields vs 11 in example
2. **Complex filtering** - 20+ filter types vs 3 in example
3. **Multi-step data fetching** - 5 data sources vs 2 in example
4. **Advanced pagination** - cursor-based with adaptive batching
5. **Metrics population** - full stats object with all reaction types

## Migration Strategy

1. **Parallel implementation** - Keep existing code working
2. **Feature flag** - Use existing FEED_POST_FILTER flag to route to new implementation
3. **Gradual rollout** - Test with small percentage of traffic
4. **Monitoring** - Compare performance and results
5. **Full migration** - Once validated, remove old code

## Implementation Decisions

Based on feedback:

1. **Post-filtering logic:** Implemented in populateDocuments using ctx.pg, ctx.cache
2. **prioritizedUserIds:** Not implemented (not currently supported in getImagesFromSearchPostFilter)
3. **Metrics-only update:** Optional optimization, may implement later
4. **Flipt client:** Optional interface can be added to Feed context in base.ts for feature-flagged existence checks 
