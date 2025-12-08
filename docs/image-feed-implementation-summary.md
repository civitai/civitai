# Image Feed Implementation Summary

## Overview

I've successfully migrated the `getImagesFromSearchPostFilter` functionality to the new `event-engine-common` Feed system. The implementation provides a unified, type-safe interface for querying, populating, and creating image documents in Meilisearch.

## What Was Implemented

### 1. Type Definitions (`event-engine-common/types/image-feed-types.ts`)

Ported all necessary types and enums from the main codebase:

- **Enums:**
  - `ImageSort` - sorting options (Most Reactions, Most Comments, Most Collected, Newest, Oldest)
  - `NsfwLevel` - NSFW content levels (PG, PG13, R, X, XXX, Blocked)
  - `Availability` - content availability (Public, Private, Unsearchable)
  - `BlockedReason` - reasons for blocking (TOS, Moderated, CSAM, AiNotVerified)
  - `MediaType` - media types (image, video, audio)

- **Document Types:**
  - `ImageDocument` - Meilisearch document (30+ fields)
  - `PopulatedImage` - Fully populated image with stats, user, tags, cosmetics
  - `SearchBaseImage` - Base image data from PostgreSQL

- **Input Types:**
  - `ImageQueryInput` - Complete filter options (20+ filter types)

- **Helper Functions:**
  - `includesNsfwContent()` - Check if browsing level includes NSFW
  - `browsingLevelToArray()` - Convert flag to array of levels
  - `onlySelectableLevels()` - Filter out non-selectable levels
  - `snapToInterval()` - Round timestamp for better caching

### 2. Cache Definitions (`event-engine-common/caches/imageData.cache.ts`)

Created 5 new caches for the Image Feed:

- **`imageTagIds`** - Tag IDs associated with images
- **`tagData`** - Full tag information (name, type, nsfwLevel)
- **`cosmeticData`** - Cosmetic information
- **`userCosmetics`** - Equipped cosmetics for users
- **`profilePictures`** - User profile picture data

All caches use the Feed-compatible `createCache` interface with 24-hour TTL.

### 3. Image Feed (`event-engine-common/feeds/images.feed.ts`)

Implemented comprehensive feed with three main methods:

#### createDocuments
Replicates logic from `metrics-images.search-index.ts`:

**Process:**
1. Fetch base image data from PostgreSQL (sortAt, hasMeta, onSite, etc.)
2. Fetch metrics from ClickHouse via metric service
3. Fetch tags from cache
4. Fetch tools/techniques from PostgreSQL
5. Fetch model versions from PostgreSQL
6. Transform and combine all data into Meilisearch documents

**Features:**
- Supports 'full' and 'metrics' update types
- Batching for large ID sets (1000 per batch)
- Proper POI detection (image.poi ?? resource.poi)
- Combined NSFW level calculation
- Flags extraction (promptNsfw)

#### queryDocuments
Replicates filter logic from `getImagesFromSearchPostFilter`:

**Supports 20+ Filter Types:**
- NSFW level filtering (browsingLevel → combinedNsfwLevel/nsfwLevel)
- Model version filtering (postedToId, modelVersionIds, modelVersionIdsManual)
- Remix filtering (remixOfId, remixesOnly, nonRemixesOnly)
- Tag/tool/technique filtering
- Type filtering (image/video/audio)
- Period filtering (Day, Week, Month, Year, AllTime)
- User filtering (userId, excludedUserIds, followed, hidden)
- POI/minor filtering
- Metadata filtering (hasMeta, onSite, requiringMeta)
- Publishing status filtering (notPublished, scheduled)
- Moderator features (blockedFor, poiOnly, minorOnly)

**Features:**
- Database lookups for hidden/followed images
- Username to userId conversion
- NSFW license restrictions placeholder
- Multiple sort orders (reactions, comments, collected, newest, oldest)
- Pagination via context

#### populateDocuments
Enhances documents with additional data:

**Fetches:**
1. Metrics from ClickHouse (via metric service)
2. User data (username, avatar, deletedAt)
3. Profile pictures
4. User cosmetics (equipped cosmetics)
5. Tag data (full tag information)
6. Cosmetic data

**Returns:**
- Fully populated images with:
  - Stats object (all reaction counts, comments, collections, tips)
  - User object (username, image, deletedAt, profilePictureId)
  - Tags array (id, name, type, nsfwLevel)
  - Cosmetics array (id, name, type, data, source)

## File Structure

```
event-engine-common/
├── types/
│   └── image-feed-types.ts          ← New types and enums
├── caches/
│   ├── imageData.cache.ts            ← New caches
│   └── index.ts                      ← Updated exports
└── feeds/
    ├── images.feed.ts                 ← New comprehensive feed
    └── index.ts                       ← Updated exports
```

## Usage Example

```typescript
import { ImagesFeed } from 'event-engine-common/feeds';
import { meilisearch, clickhouse, pg, metricService, cacheService } from '...';

// Initialize feed
const feed = new ImagesFeed(
  meilisearch,
  clickhouse,
  pg,
  metricService,
  cacheService
);

// Query images with filters
const images = await feed.populatedQuery({
  limit: 100,
  sort: 'Most Reactions',
  browsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
  period: 'Week',
  tags: [123, 456],
  currentUserId: 789,
});

// Upsert images to Meilisearch
await feed.upsert([1, 2, 3, 4, 5], 'full');

// Delete images from Meilisearch
await feed.delete([1, 2, 3]);
```

## Schema (30+ Fields)

The Meilisearch index contains:

**Primary:** id, index

**Basic:** sortAt, sortAtUnix, type, userId, postId, url, width, height, hash, hideMeta

**Model/Resources:** modelVersionIds, modelVersionIdsManual, postedToId, baseModel

**NSFW/Safety:** nsfwLevel, combinedNsfwLevel, availability, blockedFor, poi, minor

**Tags/Tools/Techniques:** tagIds, toolIds, techniqueIds

**Metadata:** hasMeta, onSite, publishedAtUnix, existedAtUnix, remixOfId, flags.promptNsfw

**Metrics:** reactionCount, commentCount, collectedCount

## Migration Path

### For Search Job Migration

Replace the current `imagesMetricsDetailsSearchIndex` with:

```typescript
// Instead of using createSearchIndexUpdateProcessor
import { ImagesFeed } from 'event-engine-common/feeds';

// Use feed.upsert() for batch updates
await feed.upsert(imageIds, 'full');
```

### For API Query Migration

Replace `getImagesFromSearchPostFilter` with:

```typescript
// Old
const { data, nextCursor } = await getImagesFromSearchPostFilter(input);

// New
const feed = new ImagesFeed(...);
const images = await feed.populatedQuery({
  limit: input.limit,
  sort: input.sort,
  browsingLevel: input.browsingLevel,
  // ... all other filters
});
```

## Key Differences from Original

### Improvements
1. **Type-safe** - All types inferred from config
2. **Modular** - Caches can be reused across feeds
3. **Testable** - Each method can be tested independently
4. **Consistent** - Same pattern as other feeds
5. **Maintainable** - Clear separation of concerns

### Limitations/TODOs
1. **NSFW License Restrictions** - Commented out, needs dynamic configuration
2. **Cursor-based pagination** - Meilisearch uses offset-based, may need adjustment
3. **Adaptive batch sizing** - Original has adaptive batching for post-filtering, not implemented
4. **Post-filtering logic** - Existence checks, permission validation planned but not implemented in populateDocuments yet
5. **Flipt integration** - Feature flag support not added to base Feed context

## Next Steps

1. **Add post-filtering to populateDocuments:**
   - Existence checks (Redis cache + DB fallback)
   - Permission validation (private/blocked content)
   - Scheduled post filtering (for non-owners)
   - NSFW level validation (unscanned content)

2. **Add Flipt client to Feed context:**
   - Optional interface in `feeds/base.ts`
   - Support for feature-flagged existence checks

3. **NSFW restricted base models:**
   - Add configuration option or fetch from database
   - Implement filtering in queryDocuments

4. **Testing:**
   - Unit tests for each method
   - Integration tests with real Meilisearch
   - Performance comparison with current implementation

5. **Integration:**
   - Update API to use new feed
   - Update search job to use feed.upsert()
   - Feature flag rollout

## Questions/Decisions Made

1. ✅ **Post-filtering logic:** Will be in populateDocuments (per feedback)
2. ✅ **prioritizedUserIds:** Not implemented (not in current implementation)
3. ⏳ **Metrics-only update:** Optional, may implement later
4. ⏳ **Flipt client:** Optional interface can be added to base.ts

## Files Changed

- Created: `event-engine-common/types/image-feed-types.ts`
- Created: `event-engine-common/caches/imageData.cache.ts`
- Created: `event-engine-common/feeds/images.feed.ts`
- Updated: `event-engine-common/caches/index.ts`
- Updated: `event-engine-common/feeds/index.ts`
- Created: `docs/image-feed-migration-plan.md`
- Created: `docs/image-feed-implementation-summary.md`

## Estimated Impact

- **Search Job:** Can be simplified to use `feed.upsert()` instead of complex multi-step processor
- **API:** Cleaner, more maintainable code with type safety
- **Performance:** Should be similar or better due to efficient caching and batching
- **Future Feeds:** Can follow same pattern for Posts, Articles, etc.
