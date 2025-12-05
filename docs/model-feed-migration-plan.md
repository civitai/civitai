# Model Feed Migration Plan

## Overview

Migrate `getModelsWithImagesAndModelVersions` functionality from `src/server/services/model.service.ts` to the new `event-engine-common` Feed system. This will provide a unified, type-safe interface for querying, populating, and creating model documents in Meilisearch.

**Target Function:** `getModelsWithImagesAndModelVersions` (line 1068)
- Wraps `getModelsRaw` and adds image fetching for model versions
- Returns a simplified structure with single `version` (not array) and `images`
- Used by the main model feed/listing endpoints

This migration follows the same pattern established by the Image Feed implementation.

## ⚠️ CRITICAL: Type Safety Requirements

**DO NOT use `any` type anywhere in this implementation.**

All types must be explicitly defined. When working with:
- Cache results: Use proper type inference or explicit type aliases
- Database queries: Define explicit result types
- JSON fields: Use `unknown` with type guards or explicit interfaces
- Optional data: Use proper union types (`Type | null | undefined`)

Reference the Image Feed implementation (`event-engine-common/feeds/images.feed.ts`) for patterns on handling conditional Promise.all results with proper typing.

## Current Implementation Analysis

### `getModelsRaw` (src/server/services/model.service.ts:216-795)

**Responsibilities:**
- Builds complex PostgreSQL queries against `ModelMetric` + `Model` tables
- Optional text search via Meilisearch (`MODELS_SEARCH_INDEX`)
- Post-processes results with version filtering, tag filtering, NSFW restrictions
- Populates with user data, profile pictures, cosmetics, model versions, hashes, tags

**Key Data Sources:**
1. **PostgreSQL** (`ModelMetric` mm + `Model` m) - Base model data with metrics
2. **Meilisearch** - Text search for query parameter (optional)
3. **`dataForModelsCache`** - Model versions, hashes, tags
4. **`userBasicCache`** - User basic info (username, image, deletedAt)
5. **`getProfilePicturesForUsers`** - User profile pictures
6. **`getCosmeticsForUsers`** - User cosmetics
7. **`getCosmeticsForEntity`** - Model cosmetics (when `include` has 'cosmetics')

**Input Parameters (~40+ filters):**
```typescript
{
  // Pagination
  take?: number;
  skip?: number;
  cursor?: string;

  // User/Auth
  user?: string;                  // username filter
  username?: string;              // username filter (alias)
  followed?: boolean;             // only followed users
  hidden?: boolean;               // user's hidden models
  excludedUserIds?: number[];

  // Content filters
  query?: string;                 // text search
  ids?: number[];
  modelVersionIds?: number[];
  tag?: string;
  tagname?: string;
  types?: ModelType[];
  baseModels?: BaseModel[];
  checkpointType?: CheckpointType;

  // Status/Availability
  status?: ModelStatus[];
  archived?: boolean;
  pending?: boolean;
  availability?: Availability;
  earlyAccess?: boolean;

  // Permissions
  allowNoCredit?: boolean;
  allowDifferentLicense?: boolean;
  allowDerivatives?: boolean;
  allowCommercialUse?: CommercialUse[];

  // Features
  supportsGeneration?: boolean;
  fromPlatform?: boolean;
  needsReview?: boolean;
  isFeatured?: boolean;

  // Collections/Clubs
  collectionId?: number;
  collectionTagId?: number;
  clubId?: number;

  // NSFW/Safety
  browsingLevel?: number;
  disablePoi?: boolean;
  disableMinor?: boolean;
  poiOnly?: boolean;               // moderator only
  minorOnly?: boolean;             // moderator only

  // Sorting
  sort?: ModelSort;
  period?: MetricTimeframe;
  periodMode?: 'stats' | 'published';

  // File filters
  fileFormats?: string[];
}
```

**Sort Options:**
- `Newest` (default): `lastVersionAt DESC`
- `Oldest`: `lastVersionAt ASC`
- `HighestRated`: `thumbsUpCount DESC, downloadCount DESC`
- `MostLiked`: `thumbsUpCount DESC, downloadCount DESC`
- `MostDownloaded`: `downloadCount DESC, thumbsUpCount DESC`
- `MostDiscussed`: `commentCount DESC, thumbsUpCount DESC`
- `MostCollected`: `collectedCount DESC, thumbsUpCount DESC`
- `ImageCount`: `imageCount DESC, thumbsUpCount DESC`

**Output Structure (getModelsWithImagesAndModelVersions):**
```typescript
{
  items: Array<{
    // Base model fields
    id: number;
    name: string;
    type: ModelType;
    nsfw: boolean;
    nsfwLevel: number;
    minor: boolean;
    poi: boolean;
    sfwOnly: boolean;
    status: ModelStatus;
    createdAt: Date;
    lastVersionAt: Date;
    publishedAt: Date | null;
    locked: boolean;
    earlyAccessDeadline: Date | null;
    mode: ModelModifier | null;
    availability: Availability;

    // User
    user: {
      id: number;
      username: string | null;
      deletedAt: Date | null;
      image: string | null;
      profilePicture?: ProfileImage | null;
      cosmetics?: UserCosmetic[];
    };

    // Model cosmetic
    cosmetic?: ContentDecorationCosmetic | null;

    // Tags (simplified - just IDs)
    tags: number[];

    // Hashes (lowercase)
    hashes: string[];

    // Metrics (normalized - no period suffix)
    rank: {
      downloadCount: number;
      thumbsUpCount: number;
      thumbsDownCount: number;
      commentCount: number;
      collectedCount: number;
      tippedAmountCount: number;
    };

    // Single version (first/primary version)
    version: ModelVersionDetails;

    // Images for the version
    images: ImagesForModelVersions[];

    // Generation support
    canGenerate: boolean;
  }>;
  nextCursor?: string | bigint;
  isPrivate: boolean;
}
```

---

## Implementation Plan

### Phase 1: Type Definitions

**File:** `event-engine-common/types/model-feed-types.ts`

Port necessary types and enums:

```typescript
// Enums
export enum ModelSort {
  Newest = 'Newest',
  Oldest = 'Oldest',
  HighestRated = 'Highest Rated',
  MostLiked = 'Most Liked',
  MostDownloaded = 'Most Downloaded',
  MostDiscussed = 'Most Discussed',
  MostCollected = 'Most Collected',
  ImageCount = 'Most Images',
}

// Already exists in shared: ModelType, ModelStatus, CheckpointType,
// Availability, CommercialUse, BaseModel

// Document type (Meilisearch)
export interface ModelDocument {
  // Primary
  id: number;

  // Basic
  name: string;
  type: string;
  nsfw: boolean;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  locked: boolean;

  // Timestamps
  createdAt: Date;
  lastVersionAt: Date;
  lastVersionAtUnix: number;
  publishedAt: Date | null;
  publishedAtUnix: number | null;
  earlyAccessDeadline: Date | null;

  // Metrics
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
  imageCount: number;

  // User
  userId: number;

  // Filtering arrays
  tagIds: number[];
  baseModels: string[];           // All base models from versions
  modelVersionIds: number[];      // All version IDs

  // Permissions
  allowNoCredit: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  allowCommercialUse: string[];

  // Features
  supportsGeneration: boolean;
  fromPlatform: boolean;

  // Checkpoint-specific
  checkpointType: string | null;
}

// Query input
export interface ModelQueryInput {
  // Pagination
  take?: number;
  cursor?: string;

  // Text search
  query?: string;

  // ID filters
  ids?: number[];
  modelVersionIds?: number[];

  // User filters
  userId?: number;
  username?: string;
  followed?: boolean;
  hidden?: boolean;
  excludedUserIds?: number[];

  // Content filters
  tag?: string;
  tagname?: string;
  tagIds?: number[];
  excludedTagIds?: number[];
  types?: string[];
  baseModels?: string[];
  checkpointType?: string;

  // Status filters
  status?: string[];
  archived?: boolean;
  pending?: boolean;
  availability?: string;
  earlyAccess?: boolean;

  // Permission filters
  allowNoCredit?: boolean;
  allowDifferentLicense?: boolean;
  allowDerivatives?: boolean;
  allowCommercialUse?: string[];

  // Feature filters
  supportsGeneration?: boolean;
  fromPlatform?: boolean;
  needsReview?: boolean;
  isFeatured?: boolean;

  // Collection/Club filters
  collectionId?: number;
  collectionTagId?: number;
  clubId?: number;

  // NSFW/Safety
  browsingLevel?: number;
  disablePoi?: boolean;
  disableMinor?: boolean;
  poiOnly?: boolean;
  minorOnly?: boolean;

  // Sorting
  sort?: ModelSort;
  period?: string;
  periodMode?: string;

  // File filters
  fileFormats?: string[];

  // NSFW restrictions
  nsfwRestrictedBaseModels?: string[];

  // Session context
  currentUserId?: number;
  isModerator?: boolean;

  // Include options
  include?: Array<'details' | 'cosmetics'>;

  // Existence checking (for post-filter)
  enableExistenceCheck?: boolean;
}

// ============================================================================
// Supporting Types (NO `any` allowed)
// ============================================================================

// Profile picture type (from ProfileImage selector)
export interface ModelFeedProfilePicture {
  id: number;
  name: string | null;
  url: string;
  nsfwLevel: number;
  hash: string | null;
  userId: number;
  ingestion: string;
  type: string;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
}

// User cosmetic type
export interface ModelFeedUserCosmetic {
  cosmeticId: number;
  data: Record<string, unknown> | null;
  cosmetic: {
    id: number;
    name: string;
    type: string;
    source: string;
    data: Record<string, unknown>;
  };
}

// Model cosmetic type (content decoration)
export interface ModelFeedContentCosmetic {
  id: number;
  type: string;
  name: string;
  data: {
    url?: string;
    offset?: number;
    crop?: string;
    cssFrame?: string;
    glow?: boolean;
    texture?: { url: string; size: { width: number; height: number } };
    lights?: number;
  };
  equippedToId: number;
  claimKey: string | null;
}

// Model version details type
export interface ModelFeedVersionDetails {
  id: number;
  index: number;
  name: string;
  earlyAccessTimeFrame: number;
  baseModel: string;
  baseModelType: string;
  createdAt: Date;
  trainingStatus: string | null;
  description: string | null;
  trainedWords: string[];
  vaeId: number | null;
  publishedAt: Date | null;
  status: string;
  covered: boolean;
  availability: string;
  nsfwLevel: number;
}

// Model data from cache
export interface ModelFeedCacheData {
  modelId: number;
  hashes: string[];
  tags: { tagId: number; name: string }[];
  versions: ModelFeedVersionDetails[];
}

// User data from cache
export interface ModelFeedUserData {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
}

// ============================================================================
// Populated Output (NO `any` allowed)
// ============================================================================

export interface PopulatedModelUser {
  id: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
  profilePicture: ModelFeedProfilePicture | null;
  cosmetics: ModelFeedUserCosmetic[];
}

export interface PopulatedModel extends ModelDocument {
  rank: Record<string, number>;
  modelVersions: ModelFeedVersionDetails[];
  hashes: string[];
  tagsOnModels: { tagId: number; name: string }[];
  user: PopulatedModelUser;
  cosmetic: ModelFeedContentCosmetic | null;
}
```

---

### Phase 2: Cache Definitions

**File:** `event-engine-common/caches/modelData.cache.ts`

Create/update caches needed for model feed:

```typescript
// Model tags cache
export const modelTagIds = createCache<{ modelId: number; tags: number[] }>({
  redisKey: 'model:tags',
  idKey: 'modelId',
  ttl: 60 * 60 * 24,
  async fetch(ctx, ids) {
    // Fetch tag IDs for models from TagsOnModels
  },
});

// Model versions cache (simplified for feed)
export const modelVersions = createCache<{
  modelId: number;
  versions: { id: number; baseModel: string; status: string; availability: string; nsfwLevel: number }[];
}>({
  redisKey: 'model:versions',
  idKey: 'modelId',
  ttl: 60 * 60 * 24,
  async fetch(ctx, ids) {
    // Fetch versions for models
  },
});

// Model hashes cache
export const modelHashes = createCache<{ modelId: number; hashes: string[] }>({
  redisKey: 'model:hashes',
  idKey: 'modelId',
  ttl: 60 * 60 * 24,
  async fetch(ctx, ids) {
    // Fetch SHA256 hashes
  },
});
```

**Note:** We can also reuse/mirror the existing `dataForModelsCache` pattern but in event-engine-common format.

---

### Phase 3: Schema Definition

**File:** `event-engine-common/feeds/models.feed.ts`

```typescript
const schema = {
  // Primary
  id: { type: 'number' as const, primary: true, filterable: true },

  // Basic fields
  name: { type: 'string' as const },
  type: { type: 'string' as const, filterable: true },
  nsfw: { type: 'boolean' as const, filterable: true },
  nsfwLevel: { type: 'number' as const, filterable: true },
  minor: { type: 'boolean' as const, filterable: true },
  poi: { type: 'boolean' as const, filterable: true },
  sfwOnly: { type: 'boolean' as const, filterable: true },
  status: { type: 'string' as const, filterable: true },
  mode: { type: 'string' as const, filterable: true },
  availability: { type: 'string' as const, filterable: true },
  locked: { type: 'boolean' as const, filterable: true },

  // Timestamps
  lastVersionAt: { type: 'Date' as const, sortable: true },
  lastVersionAtUnix: { type: 'number' as const, filterable: true },
  publishedAtUnix: { type: 'number' as const, filterable: true },
  earlyAccessDeadlineUnix: { type: 'number' as const, filterable: true },

  // Metrics - sortable AND filterable for cursor pagination
  downloadCount: { type: 'number' as const, sortable: true, filterable: true },
  thumbsUpCount: { type: 'number' as const, sortable: true, filterable: true },
  thumbsDownCount: { type: 'number' as const, sortable: true, filterable: true },
  commentCount: { type: 'number' as const, sortable: true, filterable: true },
  collectedCount: { type: 'number' as const, sortable: true, filterable: true },
  tippedAmountCount: { type: 'number' as const, sortable: true, filterable: true },
  imageCount: { type: 'number' as const, sortable: true, filterable: true },

  // User
  userId: { type: 'number' as const, filterable: true },

  // Arrays for filtering
  tagIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },
  baseModels: { type: 'array' as const, arrayType: 'string' as const, filterable: true },
  modelVersionIds: { type: 'array' as const, arrayType: 'number' as const, filterable: true },

  // Permissions
  allowNoCredit: { type: 'boolean' as const, filterable: true },
  allowDerivatives: { type: 'boolean' as const, filterable: true },
  allowDifferentLicense: { type: 'boolean' as const, filterable: true },
  allowCommercialUse: { type: 'array' as const, arrayType: 'string' as const, filterable: true },

  // Features
  supportsGeneration: { type: 'boolean' as const, filterable: true },
  fromPlatform: { type: 'boolean' as const, filterable: true },

  // Checkpoint
  checkpointType: { type: 'string' as const, filterable: true },
} as const;
```

---

### Phase 4: createDocuments Implementation

Replicate logic from how models are indexed (similar to `ModelMetric` join):

```typescript
// ============================================================================
// Database Query Result Types (NO `any` allowed)
// ============================================================================

interface ModelBaseQueryResult {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  locked: boolean;
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  earlyAccessDeadline: Date | null;
  userId: number;
  allowNoCredit: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  allowCommercialUse: string[];
  checkpointType: string | null;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedAmountCount: number;
  imageCount: number;
}

interface ModelVersionQueryResult {
  modelId: number;
  versionIds: number[];
  baseModels: string[];
  hasTraining: boolean;
}

interface GenerationCoverageResult {
  modelId: number;
  covered: boolean;
}

// Partial document for metrics-only updates
type ModelMetricsPartial = Pick<
  ModelDocument,
  'id' | 'downloadCount' | 'thumbsUpCount' | 'thumbsDownCount' |
  'commentCount' | 'collectedCount' | 'tippedAmountCount' | 'imageCount'
>;

// ============================================================================
// createDocuments Implementation
// ============================================================================

async function createDocuments(
  ctx: FeedContext<'Model'>,
  ids: number[],
  type: 'full' | 'metrics' = 'full'
): Promise<ModelDocument[]> {
  if (type === 'metrics') {
    // Metrics-only update from ClickHouse
    // Returns partial documents - Meilisearch will merge with existing
    const metrics = await ctx.metric.fetch(ids);
    const partialDocs: ModelMetricsPartial[] = ids.map((id) => {
      const m = metrics[id];
      return {
        id,
        downloadCount: m?.Download ?? 0,
        thumbsUpCount: m?.ThumbsUp ?? 0,
        thumbsDownCount: m?.ThumbsDown ?? 0,
        commentCount: m?.Comment ?? 0,
        collectedCount: m?.Collection ?? 0,
        tippedAmountCount: m?.Buzz ?? 0,
        imageCount: m?.Image ?? 0,
      };
    });
    // Cast is acceptable here as Meilisearch partial update
    return partialDocs as ModelDocument[];
  }

  // Full document creation
  const models = await ctx.pg.query<ModelBaseQueryResult>(`
    SELECT
      mm."modelId" as id,
      m.name,
      m.type,
      m.nsfw,
      mm."nsfwLevel",
      mm.minor,
      mm.poi,
      m."sfwOnly",
      mm.status,
      mm.mode,
      mm.availability,
      m.locked,
      m."createdAt",
      mm."lastVersionAt",
      m."publishedAt",
      m."earlyAccessDeadline",
      mm."userId",
      m."allowNoCredit",
      m."allowDerivatives",
      m."allowDifferentLicense",
      m."allowCommercialUse",
      m."checkpointType",
      mm."downloadCount",
      mm."thumbsUpCount",
      mm."thumbsDownCount",
      mm."commentCount",
      mm."collectedCount",
      mm."tippedAmountCount",
      mm."imageCount"
    FROM "ModelMetric" mm
    JOIN "Model" m ON m.id = mm."modelId"
    WHERE mm."modelId" = ANY($1)
  `, [ids]);

  // Fetch tags, versions, generation coverage
  const [tagData, versionData, generationCoverage] = await Promise.all([
    ctx.cache.fetch('modelTagIds', ids),
    fetchModelVersions(ctx, ids),
    fetchGenerationCoverage(ctx, ids),
  ]);

  return models.map((model) => ({
    ...model,
    lastVersionAtUnix: model.lastVersionAt?.getTime(),
    publishedAtUnix: model.publishedAt?.getTime(),
    earlyAccessDeadlineUnix: model.earlyAccessDeadline?.getTime(),
    tagIds: tagData[model.id]?.tags ?? [],
    baseModels: versionData[model.id]?.baseModels ?? [],
    modelVersionIds: versionData[model.id]?.versionIds ?? [],
    supportsGeneration: generationCoverage[model.id] ?? false,
    fromPlatform: versionData[model.id]?.hasTraining ?? false,
  }));
}
```

---

### Phase 5: queryDocuments Implementation

Replicate filter logic from `getModelsRaw`:

```typescript
async function queryDocuments(
  ctx: FeedContext<'Model'>,
  input: ModelQueryInput
): Promise<ModelDocument[]> {
  const filters: string[] = [];
  const sorts: string[] = [];

  // NSFW Level
  if (input.browsingLevel) {
    const levels = browsingLevelToArray(input.browsingLevel);
    filters.push(`nsfwLevel IN [${levels.join(',')}]`);
  }

  // POI/Minor
  if (input.disablePoi) filters.push('poi != true');
  if (input.disableMinor) filters.push('minor != true');
  if (input.isModerator && input.poiOnly) filters.push('poi = true');
  if (input.isModerator && input.minorOnly) filters.push('minor = true');

  // Status (default: Published for non-moderators)
  if (!input.isModerator || !input.status?.length) {
    filters.push(`status = 'Published'`);
  } else {
    filters.push(`status IN [${input.status.map(s => `'${s}'`).join(',')}]`);
  }

  // Availability
  if (input.availability) {
    filters.push(`availability = '${input.availability}'`);
  } else if (!input.isModerator) {
    filters.push(`availability != 'Private'`);
  }

  // Archived
  if (!input.archived) {
    filters.push(`mode != 'Archived'`);
  }

  // Type filtering
  if (input.types?.length) {
    filters.push(`type IN [${input.types.map(t => `'${t}'`).join(',')}]`);
  }

  // Base model filtering
  if (input.baseModels?.length) {
    filters.push(`baseModels IN [${input.baseModels.map(b => `'${b}'`).join(',')}]`);
  }

  // Tag filtering
  if (input.tagIds?.length) {
    filters.push(`tagIds IN [${input.tagIds.join(',')}]`);
  }
  if (input.excludedTagIds?.length) {
    filters.push(`tagIds NOT IN [${input.excludedTagIds.join(',')}]`);
  }

  // User filtering
  if (input.userId) {
    filters.push(`userId = ${input.userId}`);
  }
  if (input.excludedUserIds?.length) {
    filters.push(`userId NOT IN [${input.excludedUserIds.join(',')}]`);
  }

  // Feature filters
  if (input.supportsGeneration) {
    filters.push('supportsGeneration = true');
  }
  if (input.fromPlatform) {
    filters.push('fromPlatform = true');
  }

  // Permission filters
  if (input.allowNoCredit !== undefined) {
    filters.push(`allowNoCredit = ${input.allowNoCredit}`);
  }
  if (input.allowDerivatives !== undefined) {
    filters.push(`allowDerivatives = ${input.allowDerivatives}`);
  }
  if (input.allowDifferentLicense !== undefined) {
    filters.push(`allowDifferentLicense = ${input.allowDifferentLicense}`);
  }
  if (input.allowCommercialUse?.length) {
    // Note: Need to check array overlap logic for Meilisearch
    filters.push(`allowCommercialUse IN [${input.allowCommercialUse.map(c => `'${c}'`).join(',')}]`);
  }

  // Early access
  if (input.earlyAccess) {
    const now = Date.now();
    filters.push(`earlyAccessDeadlineUnix >= ${now}`);
  }

  // Period filtering
  if (input.period && input.period !== 'AllTime' && input.periodMode !== 'stats') {
    const periodMs = getPeriodMs(input.period);
    const afterDate = Date.now() - periodMs;
    filters.push(`lastVersionAtUnix >= ${afterDate}`);
  }

  // ID filters
  if (input.ids?.length) {
    filters.push(`id IN [${input.ids.join(',')}]`);
  }
  if (input.modelVersionIds?.length) {
    filters.push(`modelVersionIds IN [${input.modelVersionIds.join(',')}]`);
  }

  // Sorting
  const sort = input.sort ?? 'Newest';
  if (sort === 'HighestRated' || sort === 'MostLiked') {
    sorts.push('thumbsUpCount:desc', 'downloadCount:desc');
  } else if (sort === 'MostDownloaded') {
    sorts.push('downloadCount:desc', 'thumbsUpCount:desc');
  } else if (sort === 'MostDiscussed') {
    sorts.push('commentCount:desc', 'thumbsUpCount:desc');
  } else if (sort === 'MostCollected') {
    sorts.push('collectedCount:desc', 'thumbsUpCount:desc');
  } else if (sort === 'ImageCount') {
    sorts.push('imageCount:desc', 'thumbsUpCount:desc');
  } else if (sort === 'Oldest') {
    sorts.push('lastVersionAt:asc');
  } else {
    sorts.push('lastVersionAt:desc');
  }
  sorts.push('id:desc'); // Secondary sort

  // Execute search
  const result = await ctx.index.search<ModelDocument>(input.query ?? null, {
    filter: filters.length ? filters.join(' AND ') : undefined,
    sort: sorts,
    limit: (input.take ?? 100) + 1,
    offset: ctx.pagination.offset ?? 0,
  });

  return result.hits;
}
```

---

### Phase 6: populateDocuments Implementation

Enrich with all associated data:

```typescript
// ============================================================================
// Helper Types for populateDocuments (NO `any` allowed)
// ============================================================================

// Type aliases for cache results - enables proper type inference
type ModelDataCacheResult = Awaited<ReturnType<typeof ctx.cache.fetch<'modelData'>>>;
type UserDataCacheResult = Awaited<ReturnType<typeof ctx.cache.fetch<'userData'>>>;
type ProfilePicturesCacheResult = Awaited<ReturnType<typeof ctx.cache.fetch<'profilePictures'>>>;
type UserCosmeticsCacheResult = Awaited<ReturnType<typeof ctx.cache.fetch<'userCosmetics'>>>;
type ModelCosmeticsResult = Record<number, ModelFeedContentCosmetic>;

// Empty object types for conditional fetches
const emptyUserCosmetics: UserCosmeticsCacheResult = {};
const emptyModelCosmetics: ModelCosmeticsResult = {};

// Helper function to fetch model cosmetics with proper typing
async function fetchModelCosmetics(
  ctx: FeedContext<'Model'>,
  modelIds: number[]
): Promise<ModelCosmeticsResult> {
  if (modelIds.length === 0) return {};

  const results = await ctx.pg.query<{
    equippedToId: number;
    cosmeticId: number;
    claimKey: string | null;
    userData: Record<string, unknown> | null;
  }>(`
    SELECT "equippedToId", "cosmeticId", "claimKey", data as "userData"
    FROM "UserCosmetic"
    WHERE "equippedToId" = ANY($1) AND "equippedToType" = 'Model'::"CosmeticEntity"
  `, [modelIds]);

  if (results.length === 0) return {};

  const cosmeticIds = results.map(r => r.cosmeticId);
  const cosmeticsData = await ctx.cache.fetch('cosmeticData', cosmeticIds);

  const mapped: ModelCosmeticsResult = {};
  for (const row of results) {
    const cosmetic = cosmeticsData[row.cosmeticId];
    if (cosmetic) {
      mapped[row.equippedToId] = {
        id: cosmetic.id,
        type: cosmetic.type,
        name: cosmetic.name,
        data: cosmetic.data as ModelFeedContentCosmetic['data'],
        equippedToId: row.equippedToId,
        claimKey: row.claimKey,
      };
    }
  }
  return mapped;
}

// ============================================================================
// populateDocuments Implementation
// ============================================================================

async function populateDocuments(
  ctx: FeedContext<'Model'>,
  documents: ModelDocument[],
  input: ModelQueryInput
): Promise<PopulatedModel[]> {
  if (documents.length === 0) return [];

  const { currentUserId, isModerator, include = [] } = input;
  const includeDetails = include.includes('details');
  const includeCosmetics = include.includes('cosmetics');

  const modelIds = documents.map((d) => d.id);
  const userIds = [...new Set(documents.map((d) => d.userId))];

  // Fetch all required data in parallel with explicit types
  const [
    modelData,
    usersData,
    profilePictures,
    userCosmetics,
    modelCosmetics,
  ]: [
    ModelDataCacheResult,
    UserDataCacheResult,
    ProfilePicturesCacheResult,
    UserCosmeticsCacheResult,
    ModelCosmeticsResult,
  ] = await Promise.all([
    ctx.cache.fetch('modelData', modelIds),
    ctx.cache.fetch('userData', userIds),
    ctx.cache.fetch('profilePictures', userIds),
    includeCosmetics
      ? ctx.cache.fetch('userCosmetics', userIds)
      : Promise.resolve(emptyUserCosmetics),
    includeCosmetics
      ? fetchModelCosmetics(ctx, modelIds)
      : Promise.resolve(emptyModelCosmetics),
  ]);

  // Transform to output format with explicit null filtering
  const populated: PopulatedModel[] = [];

  for (const doc of documents) {
    const data = modelData[doc.id];
    if (!data) continue;

    // Filter versions
    let versions = data.versions;
    if (!isModerator) {
      versions = versions.filter((v) => v.status === 'Published');
    }
    if (input.baseModels?.length) {
      versions = versions.filter((v) => input.baseModels!.includes(v.baseModel));
    }
    if (input.modelVersionIds?.length) {
      versions = versions.filter((v) => input.modelVersionIds!.includes(v.id));
    }

    // NSFW license restrictions - filter versions with restricted base models
    if (input.nsfwRestrictedBaseModels?.length) {
      versions = versions.filter((v) =>
        !((v.nsfwLevel & input.browsingLevel!) !== 0 &&
          input.nsfwRestrictedBaseModels!.includes(v.baseModel))
      );
    }

    // Skip if no versions after filtering
    if (versions.length === 0) continue;

    // Only first version if not requesting details
    if (!includeDetails) versions = versions.slice(0, 1);

    // Excluded tags check
    if (input.excludedTagIds?.length) {
      const hasExcluded = data.tags.some((t) => input.excludedTagIds!.includes(t.tagId));
      if (hasExcluded) continue;
    }

    // Build rank object with period suffix
    const periodSuffix = input.period ?? 'AllTime';
    const rank: Record<string, number> = {
      [`downloadCount${periodSuffix}`]: doc.downloadCount,
      [`thumbsUpCount${periodSuffix}`]: doc.thumbsUpCount,
      [`thumbsDownCount${periodSuffix}`]: doc.thumbsDownCount,
      [`commentCount${periodSuffix}`]: doc.commentCount,
      [`collectedCount${periodSuffix}`]: doc.collectedCount,
      [`tippedAmountCount${periodSuffix}`]: doc.tippedAmountCount,
    };

    // Build user object with explicit typing
    const userData = usersData[doc.userId];
    const userCosmeticData = userCosmetics[doc.userId];

    const user: PopulatedModelUser = {
      id: doc.userId,
      username: userData?.username ?? null,
      deletedAt: userData?.deletedAt ?? null,
      image: userData?.image ?? null,
      profilePicture: profilePictures[doc.userId] ?? null,
      cosmetics: userCosmeticData?.cosmetics ?? [],
    };

    populated.push({
      ...doc,
      rank,
      modelVersions: versions,
      hashes: data.hashes,
      tagsOnModels: data.tags,
      user,
      cosmetic: modelCosmetics[doc.id] ?? null,
    });
  }

  return populated;
}
```

---

### Phase 7: Special Filters (DB Lookups)

Some filters require database lookups before querying Meilisearch:

```typescript
// In queryDocuments, before building filters:

// Handle tag name to ID lookup
if (input.tag || input.tagname) {
  const tagResult = await ctx.pg.query<{ id: number }>(`
    SELECT id FROM "Tag" WHERE name = $1
  `, [input.tag ?? input.tagname]);
  if (tagResult.length) {
    input.tagIds = [...(input.tagIds ?? []), tagResult[0].id];
  }
}

// Handle username to userId lookup
if (input.username && !input.userId) {
  const userResult = await ctx.pg.query<{ id: number }>(`
    SELECT id FROM "User" WHERE username = $1
  `, [input.username]);
  if (userResult.length === 0) return [];
  input.userId = userResult[0].id;
}

// Handle followed users
if (input.followed && input.currentUserId) {
  const followed = await ctx.pg.query<{ targetUserId: number }>(`
    SELECT "targetUserId" FROM "UserEngagement"
    WHERE "userId" = $1 AND type = 'Follow'
  `, [input.currentUserId]);
  if (followed.length === 0) return [];
  // Add to userId filter (needs OR logic or IN clause)
}

// Handle hidden models
if (input.hidden && input.currentUserId) {
  const hidden = await ctx.pg.query<{ modelId: number }>(`
    SELECT "modelId" FROM "ModelEngagement"
    WHERE "userId" = $1 AND type = 'Hide'
  `, [input.currentUserId]);
  if (hidden.length === 0) return [];
  filters.push(`id IN [${hidden.map(h => h.modelId).join(',')}]`);
}

// Handle collection filtering
if (input.collectionId) {
  // Check permissions, get model IDs from collection
  const collectionModels = await ctx.pg.query<{ modelId: number }>(`
    SELECT "modelId" FROM "CollectionItem"
    WHERE "collectionId" = $1 AND "modelId" IS NOT NULL
    ${input.collectionTagId ? `AND "tagId" = ${input.collectionTagId}` : ''}
  `, [input.collectionId]);
  if (collectionModels.length === 0) return [];
  filters.push(`id IN [${collectionModels.map(c => c.modelId).join(',')}]`);
}

// Handle featured models
if (input.isFeatured) {
  const featured = await getFeaturedModels(); // From existing service
  filters.push(`id IN [${featured.map(f => f.modelId).join(',')}]`);
}
```

---

### Phase 8: Export Feed

```typescript
export const ModelsFeed = createFeed({
  entityType: 'Model' as const,
  name: 'metrics_models_v1',
  connection: {
    host: process.env.FEED_MODEL_HOST,
    apiKey: process.env.FEED_MODEL_API_KEY,
  },
  schema,
  createDocuments,
  queryDocuments,
  populateDocuments,
  getCursor: (doc) => String(doc.lastVersionAtUnix ?? doc.id),
});
```

---

## Integration Points

### Controller Integration

**File:** `src/server/controllers/model.controller.ts`

```typescript
// Add feature flag check
const useFeedSearch = features.modelIndexFeed && input.useIndex;

if (useFeedSearch) {
  return getModelsFromFeedSearch({
    input,
    include,
    currentUserId: user?.id,
    isModerator: user?.isModerator,
  });
} else {
  return getModelsRaw({ input, include, user });
}
```

### Service Integration

**File:** `src/server/services/model.service.ts`

```typescript
export async function getModelsFromFeedSearch({
  input,
  include,
  currentUserId,
  isModerator,
}: {
  input: ModelFeedInput;
  include?: Array<'details' | 'cosmetics'>;
  currentUserId?: number;
  isModerator?: boolean;
}) {
  const feed = new ModelsFeed(
    metricsSearchClient,
    clickhouse,
    pgDbRead,
    metricService,
    cacheService
  );

  const result = await feed.populatedQuery({
    ...input,
    currentUserId,
    isModerator,
    include,
  });

  // Transform to match getModelsRaw output
  return {
    items: result.data,
    nextCursor: result.nextCursor,
    isPrivate: false, // Determined by input filters
  };
}
```

---

## File Changes Summary

### New Files
1. `event-engine-common/types/model-feed-types.ts` - Type definitions
2. `event-engine-common/feeds/models.feed.ts` - Feed implementation
3. `event-engine-common/caches/modelData.cache.ts` - Cache definitions (if not extending existing)
4. `docs/model-feed-migration-plan.md` - This document

### Modified Files
1. `event-engine-common/feeds/index.ts` - Export ModelsFeed
2. `event-engine-common/caches/index.ts` - Export new caches
3. `event-engine-common/types/index.ts` - Export new types
4. `src/server/services/model.service.ts` - Add `getModelsFromFeedSearch`
5. `src/server/controllers/model.controller.ts` - Add feature flag routing

---

## Key Differences from Image Feed

| Aspect | Image Feed | Model Feed |
|--------|------------|------------|
| Primary Table | `Image` | `ModelMetric` + `Model` |
| Metrics Source | ClickHouse | Already in `ModelMetric` table |
| Text Search | No | Yes (Meilisearch query) |
| Version Filtering | N/A | Post-filter versions |
| Tags | Simple array | Array + name lookup |
| User Filtering | Basic | Complex (followed, hidden) |
| Collections | Simple | Permission-aware |
| Output | Flat | Nested (versions, hashes) |

---

## Testing Strategy

1. **Unit Tests:**
   - createDocuments with various model types
   - queryDocuments with all filter combinations
   - populateDocuments with include options

2. **Integration Tests:**
   - Compare feed output vs `getModelsRaw` output
   - Pagination consistency
   - Sort order verification

3. **Dev Endpoints:**
   - `/api/dev-local/test-model-feed` - Basic functionality
   - `/api/dev-local/compare-model-feed` - Side-by-side comparison

4. **Metrics to Monitor:**
   - Query latency
   - Cache hit rates
   - Result count differences

---

## Rollout Plan

1. **Phase 1:** Implement and test in development
2. **Phase 2:** Deploy with feature flag disabled
3. **Phase 3:** Enable for internal users
4. **Phase 4:** Gradual rollout (10% → 50% → 100%)
5. **Phase 5:** Remove legacy code path

**Feature Flag:** `features.modelIndexFeed`

---

## Type Safety Checklist

Before merging, verify:

- [ ] **No `any` types** - All types must be explicit
- [ ] **No `as any` casts** - Use proper type narrowing or explicit interfaces
- [ ] **Database queries typed** - All `ctx.pg.query<T>()` calls have explicit result types
- [ ] **Cache results typed** - Use type aliases for `Awaited<ReturnType<...>>` patterns
- [ ] **Conditional fetches typed** - Empty objects for conditional Promise.all have proper types
- [ ] **JSON fields use `unknown`** - Never `any` for JSON/JSONB fields; use `Record<string, unknown>`
- [ ] **Null handling explicit** - Use `| null` or `| undefined` instead of optional chaining hiding types
- [ ] **Filter functions typed** - `.filter()` callbacks should have explicit return type narrowing
- [ ] **No implicit any in callbacks** - All `.map()`, `.filter()`, `.reduce()` have typed parameters

**Patterns to use:**

```typescript
// ✅ Good - Explicit type alias for cache result
type ModelDataResult = Awaited<ReturnType<typeof ctx.cache.fetch<'modelData'>>>;

// ✅ Good - Explicit DB query type
const users = await ctx.pg.query<{ id: number; username: string }>(`...`);

// ✅ Good - Type-safe conditional fetch
const cosmetics = includeCosmetics
  ? await fetchCosmetics(ids)
  : Promise.resolve({} as Record<number, CosmeticType>);

// ✅ Good - JSON field with unknown
interface DbRow {
  id: number;
  metadata: Record<string, unknown> | null;
}

// ❌ Bad - any type
const data: any = await fetch();

// ❌ Bad - implicit any in callback
items.map(x => x.id); // x is implicitly any

// ❌ Bad - as any cast
return result as any;
```

---

## Open Questions

1. Should metrics come from ClickHouse or continue using `ModelMetric` table?
2. How to handle `clubId` filtering (complex CTE in current implementation)?
3. Should `fileFormats` filtering be supported in Meilisearch or post-filter?
4. How to handle `needsReview` which requires checking both model and version meta?

---

## Rollback Plan

1. **Immediate:** Disable feature flag `features.modelIndexFeed`
2. **Code:** Revert controller routing changes
3. **Cleanup:** Feed implementation can remain for future fixes

All existing functionality remains intact - this is purely additive.
