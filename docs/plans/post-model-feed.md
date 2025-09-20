The goal of this project is to replace the post and model feeds from being served from the database to being served from Melee Search. This would replicate the behavior that we have for the image feeds throughout the site. You can look at the metric search index to see what I'm talking about. As part of this, you'll see that we need to have a that we have a system to queue updates, to batch process those updates, and more. To kick this off, make sure you fully understand how the Image Metrics Platform works. Not Image Metrics Platform. Image. We call it Image Search Index. I don't know. You'll see it. There's two Image Search things, and it's the one dedicated to feeds. You'll see inside of the Image Service that we call against that as a Melee search instance, and this would be setting up two more Melee search instances, one for posts and one for models. So let's go ahead and start there and make sure you fully understand my request, so outline kind of the goal, and then we'll dig into the actual files.

## Project Outline: Post & Model Meilisearch Migration

### Goal
Migrate post and model feeds from database queries to Meilisearch-powered queries, following the pattern established by the Image Metrics Search Index (`metrics-images.search-index.ts`).

### Current Architecture Understanding

#### Image Metrics Search Index Pattern
Based on my analysis of the codebase, the current image search implementation uses:

1. **Meilisearch Instance**: `METRICS_IMAGES_SEARCH_INDEX` - dedicated index for image feeds
2. **Queue Update System**: Uses `SearchIndexUpdateQueueAction` for batch processing (Update/Delete actions)
3. **Data Flow**:
   - Images are pulled from PostgreSQL in batches (100,000 records at a time)
   - Metrics are pulled from ClickHouse
   - Data is transformed and enriched with tags, tools, techniques, model versions
   - Pushed to Meilisearch in batches
4. **Key Components**:
   - `metrics-images.search-index.ts`: Main index definition with filterable/sortable attributes
   - `base.search-index.ts`: Base processor for queue management and batch processing
   - `image.service.ts`: Service layer that queries Meilisearch with filters and sorts

### Proposed Implementation

#### 1. Post Feed Search Index
Create `metrics-posts.search-index.ts` following the image pattern:
- **Filterable attributes**: userId, nsfwLevel, tags, publishedAt, modelVersionId, etc.
- **Sortable attributes**: publishedAt, stats (reactions, comments, collections), etc.
- **Batch processing**: Pull posts with their metrics and relationships
- **Queue updates**: Handle create/update/delete operations

#### 2. Model Feed Search Index
Create `metrics-models.search-index.ts`:
- **Filterable attributes**: userId, type, status, tags, checkpointType, baseModel, etc.
- **Sortable attributes**: publishedAt, stats (downloads, ratings, favorites), etc.
- **Batch processing**: Pull models with versions and metrics
- **Queue updates**: Handle model lifecycle changes

#### 3. Collection Feed Search Index
Create `metrics-collections.search-index.ts`:
- **Filterable attributes**: userId, type, visibility, tags, contributorId, etc.
- **Sortable attributes**: createdAt, stats (items, followers, contributors), etc.
- **Batch processing**: Pull collections with metrics and relationships
- **Queue updates**: Handle collection modifications
@dev: Adding collections feed as requested - this will complete the migration of all major content feeds to Meilisearch

#### 3. Service Layer Updates
Update post and model services to:
- Query Meilisearch instead of database for feed operations
- Implement filter/sort builders similar to `makeMeiliImageSearchFilter`
- Handle pagination and cursor-based navigation

#### 4. Queue Integration
- Hook into existing create/update/delete operations to queue search index updates
- Use the same `SearchIndexUpdateQueueAction` enum
- Batch process updates asynchronously

### Implementation Steps

1. **Setup Meilisearch Indexes**
   - Define constants for `METRICS_POSTS_SEARCH_INDEX` and `METRICS_MODELS_SEARCH_INDEX`
   - Configure index settings (searchable, filterable, sortable attributes)

@dev: Please provide a list of searchable, filterable, and sortable attributes for each. Base this off of current filtering needs. Remember that like the Image feed index, we want to keep these documents as light as possible and keep them primarily ids and numbers. We append data after fetching from the index and keep that data in caches for rapid population.

@ai: Based on my analysis of the codebase, here are the attributes for each index:

## Post Search Index Attributes

### Searchable Attributes
- None (like images, we'll use null search with filters)

### Filterable Attributes
- `id`
- `userId`
- `modelVersionId`
- `collectionId`
- `clubId`
- `tagIds`
- `nsfwLevel`
- `publishedAtUnix`
- `createdAtUnix`
- `availability`
- `poi`
- `minor`

### Sortable Attributes
- `id`
- `publishedAt`
- `createdAt`
- `reactionCount`
- `commentCount`
- `collectedCount`

## Model Search Index Attributes

### Searchable Attributes
- None (using filters instead)

### Filterable Attributes
- `id`
- `userId`
- `type` (ModelType: Checkpoint, TextualInversion, etc.)
- `status` (ModelStatus: Published, Draft, etc.)
- `checkpointType` (Trained, Merge, etc.)
- `baseModel` (SD 1.5, SDXL, etc.)
- `tagIds`
- `nsfwLevel`
- `poi`
- `minor`
- `earlyAccess`
- `supportsGeneration`
- `fromPlatform`
- `availability`
- `publishedAtUnix`
- `lastVersionAtUnix`
- `collectionId`
- `clubId`
- `fileFormats` (SafeTensor, PickleTensor, etc.)
- `isFeatured`

### Sortable Attributes
- `id`
- `publishedAt`
- `lastVersionAt`
- `downloadCount`
- `favoriteCount`
- `commentCount`
- `ratingCount`
- `rating`

2. **Create Search Index Processors**
   - Implement data pull from PostgreSQL/ClickHouse
   - Transform data with required relationships
   - Push to Meilisearch

3. **Update Service Layers**
   - Migrate feed queries to use Meilisearch
   - Maintain backward compatibility during migration
@dev: Similar the the image feed index introduction these should just be additional functions that are added and the old way should be maintained while the root function becomes a router between the old and new way, triggered by Flipt (instead of our old feature flag system).

4. **Queue System Integration**
   - Add queue update calls to CRUD operations
   - Implement batch processing jobs
@dev: The implementation of these should strongly mirror the image feed index implementation.

5. **Testing & Migration**
   - Test with subset of data
   - Run parallel queries to compare results
   - Gradual rollout with feature flags (Flipt)

@dev: Please summarize the files you will create or edit and what you will do in each file as part of these phases. Include notes about important details for each development phase.

@ai: Here's the detailed implementation plan:

## Files to Create/Edit

### Phase 1: Core Search Index Setup

#### New Files to Create:
1. **`src/server/search-index/metrics-posts.search-index.ts`**
   - Define Post search index with filterable/sortable attributes
   - Implement `prepareBatches`, `pullData`, `transformData` functions
   - Pull from PostgreSQL for post data, ClickHouse for metrics
   - Transform data to include tagIds, metrics counts
   - Batch size: 100,000 like images

2. **`src/server/search-index/metrics-models.search-index.ts`**
   - Define Model search index with filterable/sortable attributes
   - Implement data processing pipeline
   - Include model versions aggregation (lastVersionAt)
   - Pull metrics from ClickHouse
   - Handle fileFormats array properly

3. **`src/server/common/constants.ts`** (Edit)
   - Add `METRICS_POSTS_SEARCH_INDEX = 'metrics-posts'`
   - Add `METRICS_MODELS_SEARCH_INDEX = 'metrics-models'`

### Phase 2: Service Layer Integration

#### Files to Edit:
4. **`src/server/services/post.service.ts`**
   - Add `getPostsInfiniteMeili()` function parallel to existing `getPostsInfinite()`
   - Implement filter builders: `makeMeiliPostSearchFilter()`, `makeMeiliPostSearchSort()`
   - Add Flipt feature flag check to route between old/new implementation
   - Keep result structure identical for seamless transition
@dev: Be sure to carefully mirror the caches that we are hitting after fetching things to ensure we touch the database as little as possible when fleshing out results. Consider examining how aggressively we use caches for populating data for images in the image service, and identify if there are caches that we aren't using that we should and implement them.

5. **`src/server/services/model.service.ts`**
   - Add `getModelsInfiniteMeili()` function
   - Implement filter builders for models
   - Handle complex filters like `baseModel`, `checkpointType`, `fileFormats`
   - Route through Flipt flag
@dev: Be sure to carefully mirror the caches that we are hitting after fetching things to ensure we touch the database as little as possible when fleshing out results. Consider examining how aggressively we use caches for populating data for images in the image service, and identify if there are caches that we aren't using that we should and implement them.

### Phase 3: Queue Integration

#### Files to Edit:
6. **`src/server/services/post.service.ts`** (Additional edits)
   - Add `queuePostSearchIndexUpdate()` helper
   - Call queue update in: `createPost()`, `updatePost()`, `deletePost()`, `publishPost()`
   - Use `SearchIndexUpdateQueueAction.Update/Delete`

7. **`src/server/services/model.service.ts`** (Additional edits)
   - Add `queueModelSearchIndexUpdate()` helper
   - Integrate in CRUD operations
   - Handle model version changes triggering model updates

8. **`src/server/search-index/index.ts`** (Edit)
   - Export new search indexes
   - Register with task queue system

### Phase 4: Metrics Migration

#### Files to Create:
9. **`src/server/jobs/update-metrics-posts.ts`**
   - Job to pull post metrics from ClickHouse
   - Batch update Meilisearch documents
   - Run on schedule like image metrics

10. **`src/server/jobs/update-metrics-models.ts`**
    - Similar job for model metrics
    - Include download counts, ratings

### Phase 5: Testing & Migration

#### Files to Create:
11. **`src/server/scripts/migrate-posts-to-meili.ts`**
    - One-time script to backfill all posts to Meilisearch
    - Process in batches to avoid memory issues
    - Include progress logging

12. **`src/server/scripts/migrate-models-to-meili.ts`**
    - Similar migration for models
    - Handle model versions properly

## Important Implementation Notes:

### Data Structure Considerations:
- Keep documents minimal - store only IDs and numbers
- Metrics come from ClickHouse, not PostgreSQL
- Tag IDs stored as arrays for filtering
- Unix timestamps for date filtering (better caching)

### Performance Optimizations:
- Use `snapToInterval()` for time-based caching like images
- Batch size of 100,000 for initial load
- Implement cursor-based pagination
- Cache hydrated results after Meilisearch query

### Flipt Integration:
```typescript
// Example pattern in services:
export async function getPostsInfinite(input: PostsQueryInput) {
  const useNewSearch = await getFeatureFlag('posts-meilisearch', false);
  if (useNewSearch) {
    return getPostsInfiniteMeili(input);
  }
  return getPostsInfiniteLegacy(input);
}
```

### Queue Update Pattern:
```typescript
// Following image pattern:
export async function queuePostSearchIndexUpdate({
  ids,
  action,
}: {
  ids: number[];
  action: SearchIndexUpdateQueueAction;
}) {
  await postsSearchIndex.queueUpdate(ids.map((id) => ({ id, action })));
  await postsMetricsSearchIndex.queueUpdate(ids.map((id) => ({ id, action })));
}
```

### Questions/Considerations
- Should we maintain separate indexes or combine posts/models into a unified content index?
- @dev: Separate
- What's the expected data volume for posts and models?
- @dev: 18,841,265 Posts. 684,684 Models with 869,789 total versions.
- Are there any special filtering requirements unique to posts/models vs images?
- @dev: explore the filters available in the existing getModels and getPosts routes and on the corresponding front-end.
- How should we handle the migration period (dual-write to DB and Meilisearch)?
- @dev: We'll launch the Meilisearch sync and then we'll bulk write historical data to Meilisearch to get things loaded up to date and then we'll switch over. We'll use a Flipt switch to gently rollout the switch over to ensure it works correctly.

@dev: We are going to be replacing the way we handle model and post metrics to mirror the way we handle image metrics (in clickhouse), so assume that model and post metrics will live there similar to image metrics.
