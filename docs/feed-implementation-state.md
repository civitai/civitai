# Image Feed Implementation - Current State

**Last Updated**: 2025-11-03

## Overview

Migration of the image feed from monolithic Meilisearch implementation to the event-engine-common feed framework. The goal is to make `getImagesFromFeedSearch` behave EXACTLY like `getAllImagesIndex` for seamless A/B testing.

## Current Status: ✅ TypeScript Compilation Fixed

All TypeScript errors related to the feed implementation have been resolved. The feed is now type-safe and ready for testing.

### Completed Tasks

1. ✅ **Input Type Restructuring** (`ImageSearchInput`)
   - Changed from extending `GetAllImagesInput` to extending `GetInfiniteImagesOutput`
   - Removed `useLogicalReplica` field (not needed by feeds)
   - Added `useCombinedNsfwLevel`, `currentUserId`, `isModerator` for destructured user data
   - Updated destructuring in `getImagesFromSearchPreFilter` and `getImagesFromSearchPostFilter`

2. ✅ **Return Type Compatibility**
   - Created transformation layer in `getImagesFromFeedSearch` to strip extra fields
   - Removes: `sortAtUnix`, `publishedAtUnix`, `existedAtUnix`, `tagIds`, `flags`, `aiNsfwLevel`, `combinedNsfwLevel`
   - Ensures `type` is cast to `MediaType` enum
   - Ensures `availability` is non-undefined (defaults to `Availability.Public`)

3. ✅ **Conditional Data Fetching** (respects `include` parameter)
   - Tags: Only fetched and populated when `'tags'` in `include` (otherwise empty array)
   - Tag IDs: Only fetched when `'tagIds'` in `include`
   - Profile Pictures: Only fetched when `'profilePictures'` in `include`
   - Cosmetics: Only fetched when `'cosmetics'` in `include`
   - Meta: Only fetched when `'metaSelect'` in `include`

4. ✅ **TypeScript Type Safety** (WITHOUT using `any`)
   - Proper type inference for Promise.all with conditional fetches
   - Type aliases for cache results: `ProfilePictureData`, `UserCosmeticData`, `ImageTagIdsData`, etc.
   - Explicit type casts for conditional promises (e.g., `Promise<Record<number, { meta: unknown }>>`)
   - Type assertions using `as unknown as` for client compatibility
   - Removed all implicit `any` types

5. ✅ **Controller Integration**
   - Updated `getInfiniteImagesHandler` in `image.controller.ts`
   - Passes `currentUserId` and `isModerator` to `getImagesFromFeedSearch`
   - Passes full `user` object to `getAllImages`
   - Both branches include `tagIds` in the include array

## File Changes Summary

### Modified Files

1. **`event-engine-common/feeds/images.feed.ts`**
   - Lines 1079-1136: Added proper typing for Promise.all destructuring
   - Lines 1075-1077: Added conditional logic for tags/tagIds fetching
   - Lines 1191-1204: Tags only populate when explicitly requested in `include`

2. **`src/server/services/image.service.ts`**
   - Line 1772: Changed `ImageSearchInput` to extend `GetInfiniteImagesOutput`
   - Lines 1801-1859: `getImagesFromFeedSearch` with proper type casts and transformation layer
   - Lines 1862-1907: Removed `useLogicalReplica` from destructuring in `getImagesFromSearchPreFilter`
   - Lines 2458-2503: Removed `useLogicalReplica` from destructuring in `getImagesFromSearchPostFilter`

3. **`src/server/controllers/image.controller.ts`**
   - Lines 253-288: Split controller logic for different input types
   - Feed search: passes `currentUserId`, `isModerator`
   - Standard search: passes full `user` object, `useLogicalReplica`

### Documentation Files

1. **`docs/type-comparison.md`** - Documents differences between `GetAllImagesInput` and `ImageSearchInput`
2. **`docs/return-type-comparison.md`** - Documents structural differences between return types

## Key Technical Decisions

### 1. User Data Handling
- **Decision**: Use destructured fields (`currentUserId`, `isModerator`) instead of full `user` object
- **Rationale**: Simpler, more explicit, avoids passing unnecessary session data to feeds
- **Impact**: `ImageSearchInput` extends `GetInfiniteImagesOutput` directly

### 2. Tags Behavior
- **Decision**: Tags are empty array `[]` by default, only populated when `'tags'` in `include`
- **Rationale**: Matches `getAllImagesIndex` behavior exactly
- **Impact**: Conditional fetch in `populateDocuments` based on `include` parameter

### 3. Type Safety
- **Decision**: No use of `any` type, proper type inference throughout
- **Rationale**: User requested "DO not use any" - maintain strict type safety
- **Impact**: Added type aliases and explicit Promise types for conditional fetches

## Architecture

```
Controller (image.controller.ts)
  ├─> getImagesFromFeedSearch (NEW)
  │   ├─> ImagesFeed.populatedQuery()
  │   │   ├─> queryDocuments (Meilisearch query)
  │   │   └─> populateDocuments (Fetch user/tag/cosmetic data)
  │   └─> Transform to match getAllImagesIndex output
  │
  └─> getAllImages (EXISTING)
      └─> getImagesFromSearch
          └─> Meilisearch query + hydration
```

## Testing Status

⚠️ **NOT YET TESTED** - Ready for testing but needs validation

### What to Test

1. **Basic Query** - Verify feed returns results
2. **Include Parameter** - Verify tags only appear when requested
3. **Return Type** - Verify structure matches `getAllImagesIndex`
4. **Pagination** - Verify cursor-based pagination works
5. **Filtering** - Verify all filters work (NSFW, tags, base models, etc.)
6. **User Context** - Verify `currentUserId` and `isModerator` affect results correctly

### Test Endpoints

- **Development**: `src/pages/api/dev-local/test-image-feed.ts`
- **Detailed**: `src/pages/api/dev-local/test-image-feed-detailed.ts`

**Note**: These test endpoints currently have TypeScript errors due to missing required fields in the input object.

## Known Issues

### TypeScript Errors (Unrelated to Feed)
- 17 total TypeScript errors remaining in the codebase
- All feed-related errors are FIXED ✅
- Remaining errors are mostly Prisma `updateManyAndReturn` issues in other services

### Test Endpoints
- Need to be updated with proper input types (missing required fields)

## Next Steps

### Immediate (Before Testing)
1. ✅ Fix TypeScript errors in feed implementation
2. 🔲 Fix test endpoint TypeScript errors
3. 🔲 Run test endpoints to verify feed works
4. 🔲 Compare output structure between `getAllImagesIndex` and `getImagesFromFeedSearch`

### After Initial Testing
1. 🔲 Add missing fields to `ImageQueryInput` if needed:
   - `collectionId`
   - `collectionTagId`
   - `hideAutoResources`
   - `hideManualResources`
   - `hidden`
   - `followed`
   - `prioritizedUserIds`
   - `reactions`
   - Other fields from `GetInfiniteImagesOutput` (see `docs/type-comparison.md`)

2. 🔲 Performance testing
   - Compare query times between old and new implementation
   - Monitor memory usage
   - Check cache hit rates

3. 🔲 Feature flag rollout
   - Currently controlled by `features.imageIndexFeed` flag
   - Gradual rollout to production

## Feature Flag

**Flag**: `features.imageIndexFeed`
**Location**: `image.controller.ts:261`

```typescript
const useFeedSearch = features.imageIndexFeed && input.useIndex;
```

When enabled, uses `getImagesFromFeedSearch` instead of `getAllImages`.

## Important Code Locations

### Feed Implementation
- **Feed Definition**: `event-engine-common/feeds/images.feed.ts`
- **Type Definitions**: `event-engine-common/types/image-feed-types.ts`
- **Cache Service**: `event-engine-common/services/cache.ts`
- **Metric Service**: `event-engine-common/services/metrics.ts`

### Integration Points
- **Controller**: `src/server/controllers/image.controller.ts:253-288`
- **Service**: `src/server/services/image.service.ts:1801-1859`

### Type Compatibility
- **ImageSearchInput**: `src/server/services/image.service.ts:1772-1784`
- **Transformation Layer**: `src/server/services/image.service.ts:1831-1849`

## Dependencies

### Required Services
- ✅ Meilisearch (`metricsSearchClient`)
- ✅ Clickhouse (`clickhouse`)
- ✅ PostgreSQL (`pgDbWrite`)
- ✅ Redis (`redis`, `sysRedis`)
- ✅ Flipt (`FliptSingleton`)

### Type Imports
```typescript
import { ImagesFeed } from '../../../event-engine-common/feeds';
import { MetricService } from '../../../event-engine-common/services/metrics';
import { CacheService } from '../../../event-engine-common/services/cache';
```

## Questions for Tomorrow

1. Should we add all missing fields from `GetInfiniteImagesOutput` to `ImageQueryInput`?
2. Do we need to handle `user.isModerator` differently (more granular permissions)?
3. Should we implement caching for feed results?
4. What's the rollout strategy for the feature flag?

## Rollback Plan

If issues are discovered:

1. **Immediate**: Disable feature flag `features.imageIndexFeed`
2. **Code**: Revert controller changes (lines 253-288)
3. **Cleanup**: Can leave feed implementation in place for future fixes

All existing functionality remains intact - this is purely additive.
