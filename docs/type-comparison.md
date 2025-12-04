# Type Comparison: GetAllImagesInput vs ImageSearchInput

## Type Hierarchy

```typescript
// Base
baseQuerySchema = {
  browsingLevel: number (default: allBrowsingLevelsFlag)
}

// Extended by getInfiniteImagesSchema
GetInfiniteImagesOutput = baseQuerySchema + {
  // From imagesQueryParamSchema
  baseModels?: BaseModel[]
  collectionId?: number
  collectionTagId?: number
  hideAutoResources?: boolean
  hideManualResources?: boolean
  followed?: boolean
  fromPlatform?: boolean
  hidden?: boolean
  limit: number (min: 0, max: 200, default: galleryFilterDefaults.limit)
  modelId?: number
  modelVersionId?: number
  notPublished?: boolean
  period: MetricTimeframe (default: galleryFilterDefaults.period)
  periodMode?: PeriodMode
  postId?: number
  prioritizedUserIds?: number[]
  reactions?: ReviewReactions[]
  scheduled?: boolean
  sort: ImageSort (default: galleryFilterDefaults.sort)
  tags?: number[]
  techniques?: number[]
  tools?: number[]
  types?: MediaType[]
  useIndex?: boolean
  userId?: number
  username?: string
  withMeta: boolean (default: false)
  requiringMeta?: boolean

  // Additional fields
  cursor?: bigint | number | string | Date
  excludedTagIds?: number[]
  excludedUserIds?: number[]
  generation?: ImageGenerationProcess[]
  ids?: number[]
  imageId?: number
  include: ImageInclude[] (default: ['cosmetics'])
  includeBaseModel?: boolean
  pending?: boolean
  postIds?: number[]
  reviewId?: number
  skip?: number
  withTags?: boolean
  remixOfId?: number
  remixesOnly?: boolean
  nonRemixesOnly?: boolean
  disablePoi?: boolean
  disableMinor?: boolean

  // Mod only
  poiOnly?: boolean
  minorOnly?: boolean
}

// GetAllImagesInput adds to GetInfiniteImagesOutput
GetAllImagesInput = GetInfiniteImagesOutput + {
  useCombinedNsfwLevel?: boolean
  user?: SessionUser  // ← FULL USER OBJECT
  headers?: Record<string, string>
  useLogicalReplica: boolean  // ← REQUIRED
}

// ImageSearchInput adds to GetAllImagesInput
ImageSearchInput = GetAllImagesInput + {
  currentUserId?: number  // ← EXTRACTED FROM user?.id
  isModerator?: boolean   // ← EXTRACTED FROM user?.isModerator
  offset?: number         // ← FOR CURSOR PAGINATION
  entry?: number          // ← FOR CURSOR PAGINATION
  blockedFor?: string[]   // ← ADDITIONAL FILTER
}
```

## Key Differences

### Fields in GetAllImagesInput NOT in ImageSearchInput:
None - `ImageSearchInput` extends `GetAllImagesInput`, so it has all fields plus additional ones.

### Fields in ImageSearchInput NOT in GetAllImagesInput:
1. **`currentUserId?: number`** - User ID extracted from `user?.id`
2. **`isModerator?: boolean`** - Moderator flag extracted from `user?.isModerator`
3. **`offset?: number`** - Pagination offset (from cursor parsing)
4. **`entry?: number`** - Pagination entry timestamp (from cursor parsing)
5. **`blockedFor?: string[]`** - Additional blocking filter

## Critical Difference: User Handling

**`GetAllImagesInput`:**
- Uses `user?: SessionUser` - the full user session object
- Contains: `id`, `isModerator`, `username`, `email`, `permissions`, etc.

**`ImageSearchInput`:**
- Uses extracted fields:
  - `currentUserId?: number` (from `user?.id`)
  - `isModerator?: boolean` (from `user?.isModerator`)

## Conversion Flow

In `getAllImagesIndex` (line 1626-1641):
```typescript
const { include, user } = input;  // Get user from input

const currentUserId = user?.id;

const { data: searchResults, nextCursor: searchNextCursor } = await getImagesFromSearch({
  ...input,
  currentUserId,           // ← Extract user ID
  isModerator: user?.isModerator,  // ← Extract moderator flag
  offset,                  // ← Parse from cursor
  entry,                   // ← Parse from cursor
});
```

## Implications for Testing

When testing with API endpoints:
- **Real implementation**: Gets `user` from session/auth → extracts `user.id` and `user.isModerator`
- **Test endpoints**: Pass `isModerator` and `currentUserId` as query parameters

**This means test endpoints cannot properly test moderator functionality unless they:**
1. Accept a real authenticated session with `user.isModerator = true`, OR
2. Mock the user object internally for dev/test purposes

## Fields NOT Currently Handled in ImageQueryInput (event-engine-common)

Looking at `event-engine-common/types/image-feed-types.ts`, the following fields from `GetInfiniteImagesOutput` may not be handled:

- `collectionId`
- `collectionTagId`
- `hideAutoResources`
- `hideManualResources`
- `hidden`
- `followed`
- `prioritizedUserIds`
- `reactions`
- `imageId`
- `includeBaseModel`
- `pending`
- `reviewId`
- `skip`
- `withTags`
- `remixesOnly`
- `nonRemixesOnly`
- `disablePoi`
- `disableMinor`
- `poiOnly` (mod only)
- `minorOnly` (mod only)

These would need to be added to `ImageQueryInput` if they're required for full compatibility.
