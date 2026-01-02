# Model Feed Implementation Plan

## Overview

Integrate the `ModelsFeed` from `event-engine-common` into the main codebase, replacing the current `getModelsWithImagesAndModelVersions` implementation with a feature-flagged approach, following the same pattern as the image feed.

## Implementation Steps

### Phase 1: Feature Flag Setup

**File:** `src/server/services/feature-flags.service.ts`

Add new feature flag:
```typescript
modelIndexFeed: ['public'],  // or ['mod'] initially for testing
```

### Phase 2: Schema Update

**File:** `src/server/schema/model.schema.ts`

Add `useIndex` parameter to `getAllModelsSchema`:
```typescript
useIndex: z.boolean().nullish(),
```

### Phase 3: Service Layer - Feed Query Function

**File:** `src/server/services/model.service.ts`

Create new function `getModelsFromFeed` that:
1. Instantiates `ModelsFeed`
2. Calls `populatedQuery` with mapped input
3. Transforms output to match `getModelsWithImagesAndModelVersions` return type

```typescript
export const getModelsFromFeed = async ({
  input,
  user,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
}) => {
  // Create feed instance
  // Map input to feed input format
  // Call feed.populatedQuery()
  // Transform result to match legacy format
  // Return { items, nextCursor, isPrivate }
};
```

### Phase 4: Controller Update

**File:** `src/server/controllers/model.controller.ts`

Modify `getModelsInfiniteHandler` to:
1. Check feature flag `features.modelIndexFeed`
2. Check `input.useIndex`
3. Route to appropriate implementation

```typescript
export const getModelsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
  const { user, features } = ctx;
  const useIndex = features.modelIndexFeed && input.useIndex;

  try {
    if (useIndex) {
      return await getModelsFromFeed({ input, user });
    } else {
      // Existing implementation
      let loopCount = 0;
      // ... rest of existing code
    }
  } catch (error) {
    // error handling
  }
};
```

### Phase 5: Frontend Integration

**File:** `src/components/Model/Infinite/ModelsInfinite.tsx` (or similar)

Update the query to include `useIndex: true`:
```typescript
const { data, ...rest } = trpc.model.getAll.useInfiniteQuery({
  ...filters,
  useIndex: true,  // Enable index usage
});
```

## Detailed Changes

### 1. Feature Flag (`feature-flags.service.ts`)

```diff
+ modelIndexFeed: ['public'],  // Start with ['mod'] for testing
```

### 2. Schema (`model.schema.ts`)

```diff
export const getAllModelsSchema = z.object({
  // ... existing fields
+ useIndex: z.boolean().nullish(),
});
```

### 3. Service (`model.service.ts`)

New imports and function:

```typescript
import { clickhouse } from '~/server/clickhouse/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { redis } from '~/server/redis/client';
import { metricsSearchClient } from '~/server/meilisearch/client';
import { ModelsFeed } from '../../event-engine-common/feeds/models.feed';
import { MetricService } from '../../event-engine-common/services/metrics';
import { CacheService } from '../../event-engine-common/services/cache';
import { ModelSort } from '../../event-engine-common/types/model-feed-types';
// ... type imports

let modelsFeedInstance: InstanceType<typeof ModelsFeed> | null = null;

function getModelsFeed(): InstanceType<typeof ModelsFeed> {
  if (!modelsFeedInstance) {
    modelsFeedInstance = new ModelsFeed(
      () => metricsSearchClient,
      clickhouse,
      pgDbWrite,
      new MetricService(clickhouse, redis),
      new CacheService(redis, pgDbWrite, clickhouse)
    );
  }
  return modelsFeedInstance;
}

export const getModelsFromFeed = async ({
  input,
  user,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
}): Promise<ReturnType<typeof getModelsWithImagesAndModelVersions>> => {
  const feed = getModelsFeed();

  // Map input to feed format
  const feedInput = {
    limit: input.limit ?? 100,
    cursor: input.cursor ? String(input.cursor) : undefined,
    query: input.query,
    sort: ModelSort[input.sort as keyof typeof ModelSort] ?? ModelSort.Newest,
    period: input.period,
    types: input.types,
    baseModels: input.baseModels,
    userId: user?.id,  // For personalization
    tagIds: input.tagIds,
    browsingLevel: input.browsingLevel,
    // ... map other fields
    includeCosmetics: true,
    currentUserId: user?.id,
    isModerator: user?.isModerator,
  };

  const result = await feed.populatedQuery(feedInput);

  // Transform to legacy format
  return {
    items: result.items.map(item => ({
      // Map feed item to legacy format
      id: item.id,
      name: item.name,
      // ... other fields
    })),
    nextCursor: result.nextCursor,
    isPrivate: false,
  };
};
```

### 4. Controller (`model.controller.ts`)

```diff
+ import { getModelsFromFeed } from '~/server/services/model.service';

export const getModelsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
+ const { user, features } = ctx;
+ const useIndex = features.modelIndexFeed && input.useIndex;

  try {
+   if (useIndex) {
+     const result = await getModelsFromFeed({ input, user });
+     if (result.isPrivate) ctx.cache.canCache = false;
+     return { items: result.items, nextCursor: result.nextCursor };
+   }
+
    // Existing implementation below
    let loopCount = 0;
    // ...
  }
};
```

### 5. Frontend (Example locations)

Files to potentially update:
- `src/components/Model/Infinite/ModelsInfinite.tsx`
- `src/pages/models/index.tsx`
- Any component using `trpc.model.getAll`

```diff
const { data } = trpc.model.getAll.useInfiniteQuery({
  ...filters,
+ useIndex: true,
});
```

## Type Mapping Reference

| Legacy Field | Feed Field | Notes |
|--------------|------------|-------|
| `id` | `id` | Direct |
| `name` | `name` | Direct |
| `type` | `type` | Direct |
| `nsfw` | `nsfw` | Direct |
| `nsfwLevel` | `nsfwLevel` | Direct |
| `user` | `user` | Needs transformation |
| `version` | `version` | First from `modelVersions` |
| `images` | `images` | From populated data |
| `rank` | `rank` | Already formatted |
| `tags` | `tagsOnModels.map(t => t.tagId)` | Extract IDs |
| `hashes` | `hashes` | Direct |
| `canGenerate` | `canGenerate` | Direct |
| `cosmetic` | `cosmetic` | Direct |

## Testing Strategy

1. **Unit Testing**: Use existing test endpoints
   - `/api/dev-local/test-model-feed-query`
   - `/api/dev-local/compare-model-feed-legacy`

2. **Feature Flag Rollout**:
   - Start with `['mod']` - only moderators see new implementation
   - Expand to `['granted']` - specific users
   - Finally `['public']` - everyone

3. **Monitoring**:
   - Add metrics counter for feed vs legacy usage
   - Log performance differences
   - Monitor error rates

## Rollback Plan

1. Set `modelIndexFeed: []` to disable for everyone
2. Or set `modelIndexFeed: ['granted']` to limit to specific users
3. Frontend can be updated to pass `useIndex: false`

## Open Questions

1. Should we add a prometheus counter like images (`modelsFeedWithoutIndexCounter`)?
2. Do we need to handle `isPrivate` differently for feed results?
3. Are there any edge cases in the loop logic that need special handling?

---

## Implementation Checklist

- [ ] Add `modelIndexFeed` feature flag
- [ ] Add `useIndex` to model schema
- [ ] Create `getModelsFromFeed` in model.service.ts
- [ ] Update `getModelsInfiniteHandler` in model.controller.ts
- [ ] Update frontend to pass `useIndex: true`
- [ ] Test with comparison endpoints
- [ ] Monitor and adjust
