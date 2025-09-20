# Post, Model & Collection Metrics Migration to ClickHouse

## Executive Summary

This document outlines the plan to migrate post, model, and collection metrics from the current PostgreSQL-based implementation to a ClickHouse + Redis architecture, following the successful pattern already implemented for image metrics.

## Current State Analysis

### Problems with Current Implementation
1. **Performance Issues**
   - All metrics run against PostgreSQL every minute
   - Heavy database load from bulk operations
   - Blocking operations affecting other queries
   - Complex aggregations across multiple timeframes (Day, Week, Month, Year, AllTime)

2. **Current Metrics Processing**
   - **Models**: Downloads, generations, ratings, comments, collections, tips
   - **Posts**: Reactions (heart, like, dislike, laugh, cry), comments, collections
   - **Collections**: Items, contributors, followers
   - All use `createMetricProcessor` with heavy SQL queries

### Image Metrics (Successful Pattern)

The image metrics system already uses:
- **ClickHouse** for event storage (`entityMetricEvents` table)
- **Redis** for caching with `EntityMetricRedisClient`
- **Bulk population** with `populateEntityMetrics`
- **Per-ID locking** to prevent thundering herd
- **Efficient aggregation** at query time

## Proposed Architecture

### 1. ClickHouse Schema Extension

We need to expand the entity types and metric types to support posts, models, and collections:

```typescript
// Extend EntityType
EntityMetric_EntityType_Type = "Image" | "Post" | "Model" | "ModelVersion" | "Collection"

// Extend MetricType
EntityMetric_MetricType_Type =
  // Existing
  | "ReactionLike" | "ReactionHeart" | "ReactionLaugh" | "ReactionCry"
  | "Comment" | "Collection" | "Buzz"
  // New for Models
  | "Download" | "Generation" | "ThumbsUp" | "ThumbsDown" | "Tip"
  // New for Posts (if needed separately from reactions)
  | "View"
  // New for Collections
  | "Follower" | "Contributor" | "Item"
```

### 2. Event Ingestion Pipeline

#### Phase 1: Dual-Write Approach
- Keep existing PostgreSQL metrics running
- Add ClickHouse event recording alongside
- Validate data consistency
@dev: we'll be setting up a new branch for this and the completion of these phases should be tags applied to milestones in the project so that we can follow this rollout plan but have everything built and ready to go.

#### Phase 2: Migration
- Switch reads to ClickHouse + Redis
- Deprecate PostgreSQL metric calculations
- Keep PostgreSQL tables for fallback

#### Phase 3: Cleanup
- Remove old metric calculation jobs
- Archive PostgreSQL metric tables

### 3. Implementation Components

#### A. Event Recording Services

**ModelMetricEventService**
```typescript
class ModelMetricEventService {
  async recordDownload(modelVersionId: number, userId: number)
  async recordGeneration(modelVersionId: number, userId: number, resourcesUsed: number[])
  async recordRating(modelId: number, modelVersionId: number, userId: number, recommended: boolean)
  async recordTip(modelId: number, modelVersionId: number | null, userId: number, amount: number)
}
```
@dev: You'll want to carefully identify all of the places you'll need to track these. One of the benefits of the current metric system is that since it looks at the database, we don't have to worry about missing an event somewhere.

**PostMetricEventService**
```typescript
class PostMetricEventService {
  async recordReaction(postId: number, imageId: number, userId: number, reaction: ReactionType)
  async recordComment(postId: number, userId: number)
  async recordCollection(postId: number, userId: number)
  async recordView(postId: number, userId: number | null)
}
```

**CollectionMetricEventService**
```typescript
class CollectionMetricEventService {
  async recordItemAdded(collectionId: number, itemType: string, itemId: number, userId: number)
  async recordContributor(collectionId: number, userId: number, permissions: string[])
  async recordFollower(collectionId: number, userId: number)
}
```

#### B. Redis Caching Layer

Extend `EntityMetricRedisClient` to handle new entity types with proper key structures:
- `entity:metrics:Model:{modelId}`
- `entity:metrics:Post:{postId}`
- `entity:metrics:Collection:{collectionId}`

#### C. Bulk Population Service

Extend `populateEntityMetrics` to handle new entity types with proper aggregation queries.

### 4. Migration Strategy
@dev: All of this work is going to be done in a day utilizing the latest in AI development tools and techniques. We will use git wisely to handle a gradual rollout to ensure performance.

#### Step 1: Infrastructure Setup (Week 1)
- [ ] Create ClickHouse migration for new entity/metric types
- [ ] Extend Redis client for new entities
- [ ] Set up monitoring dashboards

#### Step 2: Event Recording (Week 2)
- [ ] Implement event recording services
- [ ] Add event recording to existing workflows
- [ ] Start collecting data in ClickHouse

#### Step 3: Query Implementation (Week 3)
- [ ] Implement ClickHouse aggregation queries
- [ ] Add Redis caching logic
- [ ] Create fallback mechanisms

#### Step 4: Gradual Rollout (Week 4-5)
- [ ] Enable for 10% of traffic
- [ ] Monitor and compare metrics
- [ ] Fix discrepancies
- [ ] Increase to 50%, then 100%

#### Step 5: Cleanup (Week 6)
- [ ] Remove old metric jobs
- [ ] Archive PostgreSQL tables
- [ ] Update documentation

## Technical Details

### ClickHouse Table Structure

The existing `entityMetricEvents` table can be used as-is:
```sql
CREATE TABLE entityMetricEvents (
  entityType String,
  entityId UInt32,
  userId UInt32,
  metricType String,
  metricValue Int32,
  createdAt DateTime
) ENGINE = MergeTree()
ORDER BY (entityType, entityId, createdAt)
```

### Aggregation Queries

**Model Downloads (Example)**
```sql
SELECT
  entityId as modelVersionId,
  countIf(createdAt >= today()) as day,
  countIf(createdAt >= today() - 7) as week,
  countIf(createdAt >= today() - 30) as month,
  countIf(createdAt >= today() - 365) as year,
  count() as all_time
FROM entityMetricEvents
WHERE entityType = 'ModelVersion'
  AND metricType = 'Download'
  AND entityId IN (?)
GROUP BY entityId
```

### Redis Cache Structure

```typescript
{
  "Download": 1234,
  "Generation": 5678,
  "ThumbsUp": 90,
  "ThumbsDown": 10,
  "Comment": 456,
  "Collection": 789,
  "Buzz": 10000
}
```
@dev: I assume this implies a hset just like image metrics so that we can inc?

## Performance Expectations

Based on image metrics performance:
- **Query time**: ~50ms for 1000 entities (vs 2-3s in PostgreSQL)
- **Cache hit rate**: ~95% for popular content
- **Database load**: 80% reduction in PostgreSQL CPU usage
- **Memory usage**: ~500MB Redis for 1M cached entities

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data inconsistency during migration | High | Dual-write with validation |
| ClickHouse downtime | High | Fallback to PostgreSQL |
| Redis memory overflow | Medium | TTL and eviction policies |
| Metric calculation differences | Medium | Extensive testing and comparison |

## Success Criteria

1. All metrics available in < 100ms (p99)
2. PostgreSQL CPU usage reduced by > 70%
3. No data loss or inconsistencies
4. Seamless user experience during migration

## Timeline

- **Week 1-2**: Infrastructure and event recording
- **Week 3-4**: Query implementation and testing
- **Week 5-6**: Gradual rollout
- **Week 7**: Cleanup and optimization

## Next Steps

1. Review and approve this plan
2. Create detailed Jira tickets for each component
3. Set up ClickHouse dev environment for testing
4. Begin implementation with ModelVersion downloads (simplest case)

---

@ai: I'll address your comments and provide a detailed file outline below.

@dev: Great points about the event tracking locations and Redis structure. You're right about the hset - it will use the same pattern as image metrics. Here's the comprehensive file outline:

## Implementation File Outline

### 1. Schema & Type Updates

**File: `src/shared/utils/prisma/enums.ts`**
- Add new entity types to `EntityMetric_EntityType_Type`
- Add new metric types to `EntityMetric_MetricType_Type`
- Key additions: Model, ModelVersion, Post, Collection entity types
- Key additions: Download, Generation, ThumbsUp, ThumbsDown, Tip, View, Follower, Contributor, Item metric types

**File: `prisma/migrations/[timestamp]_extend_entity_metrics.sql`**
- PostgreSQL migration to add new enum values
- Ensure backward compatibility with existing data
@dev: I don't think we need to update anything in Postgres. We aren't utilizing that table anymore, it acted as a cache for Clickhouse. Instead, we can just worry about Clickhouse which should already support these new enum values...

### 2. Event Recording Services

**File: `src/server/services/entity-metric-event.service.ts`** (NEW)
- Base service class with common event recording logic
- Method: `recordEvent(entityType, entityId, userId, metricType, metricValue = 1)`
- Handles ClickHouse insertion with batching
- Implements retry logic and error handling
@dev: We have a `clickhouseTracker` system in the clickhouse client that we call to that already handles batching, we should be utilizing that... I believe we might even already do it for images, so this should mirror that behavior if so.

**File: `src/server/services/model-metric-event.service.ts`** (NEW)
- Extends base event service
- Methods:
  - `recordDownload`: Track when called from download endpoints
  - `recordGeneration`: Hook into orchestration job creation
    - @dev: I don't know that we need this. I believe those metrics are already coming out of clickhouse, no need to record an additional event...
  - `recordRating`: Hook into ResourceReview create/update
    - @dev: How will you handle updates? Will it be a minus and plus event?
  - `recordTip`: Hook into BuzzTip and Donation creation
- Critical: Map modelId to modelVersionId where needed
- Track both Model and ModelVersion entities appropriately

**File: `src/server/services/post-metric-event.service.ts`** (NEW)
- Methods:
  - `recordReaction`: Hook into ImageReaction create/update/delete
    - @dev: While we're here, what's the point of the ImageReaction table? At this point can we fetch a users reactions from the events in clickhouse? Replacing this outdated system should probably be another project. Can you prepare a plan? We'd probably need to keep a cache of user->imageReactions that we populate as images they've reacted to are loaded/accessed. Probably should be an hSet like `reactions:{userId}:{imageId}` with an array of the reactions given, the reactions can be processed as bitwise flags so that we can keep this as just a numeric value instead of an array of strings. The data can be fetched in bulk from Clickhouse as needed. We don't need per id locks because it'll always be limited to a single user so there are no herds.
  - `recordComment`: Hook into CommentV2 creation
  - `recordCollection`: Hook into CollectionItem creation
- Critical: Map from imageId to postId for reactions
- Handle reaction changes (update/delete) with negative metric values

**File: `src/server/services/collection-metric-event.service.ts`** (NEW)
- Methods:
  - `recordItemAdded`: Hook into CollectionItem creation
  - `recordContributor`: Hook into CollectionContributor changes
  - `recordFollower`: Track VIEW permission contributors
- Critical: Parse permissions array to differentiate followers vs contributors

### 3. Integration Points (Event Recording Hooks)

**File: `src/server/controllers/download.controller.ts`** (EDIT)
- Add `modelMetricEventService.recordDownload()` call
- Location: After successful download initiation
- Pass: modelVersionId, userId

**File: `src/server/services/orchestrator.service.ts`** (EDIT)
- Add `modelMetricEventService.recordGeneration()` call
- Location: When job is created with resourcesUsed
- Parse resourcesUsed array for all modelVersionIds
@dev: we don't need to do this. All that data already lives in clickhouse, you can find how we fetch that. We likely already do it correctly in the metrics service fetching from clickhouse...

**File: `src/server/services/resourceReview.service.ts`** (EDIT)
- Add `modelMetricEventService.recordRating()` calls
- Locations: create, update, delete methods
- Handle recommendation changes with appropriate metric values

**File: `src/server/services/reaction.service.ts`** (EDIT)
- Add `postMetricEventService.recordReaction()` calls
- Locations: toggleReaction, create, delete methods
- Map imageId to postId via Image table
- Handle reaction type changes

**File: `src/server/services/comment.service.ts`** (EDIT)
- Add `postMetricEventService.recordComment()` call
- Location: createComment method
- Extract postId from Thread

**File: `src/server/services/collection.service.ts`** (EDIT)
- Add all collection event recording calls
- Locations: addItem, addContributor, updateContributor methods
- Parse permissions for follower vs contributor logic

**File: `src/server/services/buzz.service.ts`** (EDIT)
- Replace `upsertBuzzTip` function to:
  1. Record tip event to ClickHouse (entityType, entityId, userId, amount)
  2. Remove all `buzzTip.findUnique`, `buzzTip.update`, `buzzTip.create` operations
  3. The buzz transaction still happens, but no BuzzTip table interaction
- Location: `upsertBuzzTip` function
- Critical: Each tip is a separate event (no accumulation in PostgreSQL)

### 4. Redis Caching Extensions

**File: `src/server/redis/entity-metric.redis.ts`** (EDIT)
- No changes needed - already supports dynamic entity types
- Key structure already handles: `entity:metrics:{entityType}:{entityId}`

**File: `src/server/redis/entity-metric-populate.ts`** (EDIT)
- Update `populateEntityMetrics` to handle new entity types
- Add specific aggregation queries for each entity type
- Critical: Different aggregation logic for different metric types
- Add helpers for Model/Post/Collection specific calculations

### 5. Query & Aggregation Services

**File: `src/server/services/model-metrics-query.service.ts`** (NEW)
- Methods:
  - `getModelMetrics(modelIds: number[], timeframe?: MetricTimeframe)`
  - `getModelVersionMetrics(versionIds: number[], timeframe?: MetricTimeframe)`
- First check Redis cache via entityMetricRedis
- On miss, call populateEntityMetrics
- Return aggregated metrics with proper timeframe calculations
@dev: I don't think we use any timeframe other than all time other than feeds, and we'll be moving all of that stuff to meilisearch feeds similar to the image feed, so I think we can drop timeframe here. Also, look at how we're doing this for image metrics, I believe it's a custom CacheHelper implementation. We should mirror that. Here's that feed plan. We should probably make a note in that doc about adding a collections feed to that: docs/plans/post-model-feed.md

**File: `src/server/services/post-metrics-query.service.ts`** (NEW)
- Method: `getPostMetrics(postIds: number[], timeframe?: MetricTimeframe)`
- Similar pattern to model metrics
- Aggregate reactions into separate counts

**File: `src/server/services/collection-metrics-query.service.ts`** (NEW)
- Method: `getCollectionMetrics(collectionIds: number[], timeframe?: MetricTimeframe)`
- Handle follower/contributor differentiation

@dev: While we're here, we should probably look at replacing the user metrics computation that runs against postgres as well, between the data we capture here we should probably have what we need to compute all user metrics as well from Clickhouse.

### 6. Migration & Compatibility Layer

**File: `src/server/metrics/migration-helper.ts`** (NEW)
- Methods:
  - `compareMetrics`: Compare old vs new metric values - @dev: Don't need this for now
  - `backfillHistoricalData`: One-time historical data migration
  - `validateMetricConsistency`: Validation during dual-write phase - @dev: Don't need this for now
- Log discrepancies for investigation

**File: `src/server/metrics/fallback.service.ts`** (NEW) - @dev: Don't want this for now
- Fallback to PostgreSQL metrics if ClickHouse is down
- Methods mirror the query services but hit PostgreSQL
- Feature flag controlled: `USE_CLICKHOUSE_METRICS`

### 7. Background Jobs Updates

**File: `src/server/jobs/update-metrics.job.ts`** (EDIT) - @dev: no gradual rollout, this is going to be a hard cutover once we change the way we compute metrics.
- Add feature flag check for gradual rollout
- Keep existing PostgreSQL logic behind flag
- Add metric comparison logic for validation phase

**File: `src/server/jobs/populate-metric-cache.job.ts`** (NEW) - @dev: no need for this. Popular stuff will always be warm with our large user base.
- Pre-warm Redis cache for popular content
- Run periodically (every hour)
- Query ClickHouse for top entities by recent activity

### 8. API Updates

@dev: I don't think these exist and if they don't exist, we don't need to add them...
**File: `src/pages/api/models/[id]/metrics.ts`** (EDIT)
- Switch to use modelMetricsQueryService
- Add fallback logic if needed

**File: `src/pages/api/posts/[id]/metrics.ts`** (EDIT)
- Switch to use postMetricsQueryService

**File: `src/pages/api/collections/[id]/metrics.ts`** (EDIT)
- Switch to use collectionMetricsQueryService

### 9. Configuration & Feature Flags

**File: `.env`** (EDIT)
- Add: `USE_CLICKHOUSE_METRICS=false` (initially)
- Add: `METRICS_ROLLOUT_PERCENTAGE=0` (for gradual rollout)

@dev: No gradual rollout
**File: `src/server/config/metrics.config.ts`** (NEW)
- Configuration for rollout percentages
- Entity type specific flags
- Validation thresholds for metric comparison

### 10. Monitoring & Observability

@dev: Is there a way to log cache hit rates through prom? We can tackle this later as a different project for cache hit tracking. Make a new plan doc for that and rip this out...
**File: `src/server/utils/metrics-monitor.ts`** (NEW)
- Track metric query performance
- Log cache hit rates
- Monitor discrepancies between old and new systems
- Send alerts if thresholds exceeded

### Critical Implementation Details

1. **Event Recording Locations**: Must be comprehensive to avoid missing events
   - Downloads: download controller, API endpoints
   - Generations: orchestrator service, job creation - @dev: Like said many times above, not needed... We shouldn't bother tracking events for things that are already coming out of clickhouse effectively, like generation counts...
   - Reactions: reaction service (create, update, delete)
   - Comments: comment service creation
   - Collections: collection item service
   - Tips: buzz service, donation service

2. **Redis Structure**: Yes, using HSET like image metrics
   - Keys: `entity:metrics:{entityType}:{entityId}`
   - Fields: metric types (Download, Generation, etc.)
   - Values: numeric counts
   - Operations: HINCRBY for increments

3. **Rollout Strategy with Git**:
   - Branch: `feature/clickhouse-metrics-migration`
   - Tags for milestones:
     - `v1-dual-write`: Event recording active
     - `v2-redis-cache`: Cache layer complete
     - `v3-10-percent`: 10% traffic rollout @dev: no gradual rollout, so adjust this part of the plan...
     - `v4-full-rollout`: 100% traffic
     - `v5-cleanup`: PostgreSQL metrics removed

@ai: I'll revise the plan based on your feedback and create the additional plans you've requested.

@dev: Exactly - I'll search for all INSERT/UPDATE/DELETE operations on the tables we currently read from in the metrics jobs. Here's my search strategy:

**Search Strategy for Comprehensive Event Tracking:**
1. Find all writes to `ResourceReview` table (for ratings)
2. Find all writes to `BuzzTip` and `Donation` tables (for tips)
3. Find all writes to `ImageReaction` table (for post reactions)
4. Find all writes to `CommentV2` table (for comments)
5. Find all writes to `CollectionItem` table (for collections)
6. Find all model download endpoints/controllers
7. Cross-reference with current metric calculations to ensure nothing is missed

## Revised Implementation Plan (Based on Feedback)

### 1. Schema & Type Updates

**File: `src/shared/utils/prisma/enums.ts`**
- Add new entity types and metric types
- No PostgreSQL migration needed - ClickHouse already supports string enums

### 2. Event Recording Services

**File: `src/server/services/entity-metric-event.service.ts`** (NEW)
- Use existing `clickhouseTracker` from clickhouse client
- Mirror image metrics implementation pattern
- Method: `recordEvent(entityType, entityId, userId, metricType, metricValue = 1)`

**File: `src/server/services/model-metric-event.service.ts`** (NEW)
- Methods:
  - `recordRating`: Handle create/update/delete with -1/+1 events for changes
  - `recordTip`: Track tips from BuzzTip and Donation
- Skip download tracking (already in ClickHouse `modelVersionEvents` table with type='Download')
- Skip generation tracking (already in ClickHouse from orchestration data)
@ai: Confirmed - downloads are already tracked in `modelVersionEvents` table, no need for additional recording

**File: `src/server/services/post-metric-event.service.ts`** (NEW)
- `recordReaction`: Track reactions with -1/+1 for changes
- `recordComment`: Track comment creation
- `recordCollection`: Track collection additions

**File: `src/server/services/collection-metric-event.service.ts`** (NEW)
- Track items, contributors, and followers

### 3. Integration Points

**Key locations to modify:**
- Download endpoints for model downloads
- ResourceReview service for ratings (handle updates with -1/+1)
- Reaction service for post reactions
- Comment service for comments
- Collection service for collection items
- Buzz/Donation services for tips

*Note: Skip orchestrator service - generations already tracked in ClickHouse*

### 4. Query Services

**File: `src/server/services/model-metrics-cache.service.ts`** (NEW)
- Use CacheHelper pattern like image metrics
- No timeframe parameter (only AllTime used)
- Methods: `getModelMetrics`, `getModelVersionMetrics`

**File: `src/server/services/post-metrics-cache.service.ts`** (NEW)
- Similar to model metrics

**File: `src/server/services/collection-metrics-cache.service.ts`** (NEW)
- Handle follower/contributor differentiation

### 5. Migration Strategy

**File: `src/server/metrics/migration-helper.ts`** (NEW)
- Only include `backfillHistoricalData` method
- Skip comparison and validation methods

### 6. Background Jobs

**File: `src/server/jobs/update-metrics.job.ts`** (EDIT)
- Hard cutover - no gradual rollout
- Remove old PostgreSQL logic completely when switching

### 7. Simplified Rollout

**Git Strategy:**
- Branch: `feature/clickhouse-metrics-migration`
- Milestones:
  - `v1-dual-write`: Event recording active
  - `v2-full-cutover`: Complete switch to ClickHouse
  - `v3-cleanup`: Remove old code

## Additional Plans to Create

1. **ImageReaction Replacement Plan** (`docs/plans/image-reaction-replacement.md`)
   - Replace ImageReaction table with ClickHouse events
   - Use Redis cache: `reactions:{userId}:{imageId}` with bitwise flags
   - Bulk fetch from ClickHouse as needed
   - No per-ID locks needed (user-scoped)

2. **Cache Hit Rate Monitoring** (`docs/plans/cache-monitoring.md`)
   - Prometheus integration for cache metrics
   - Track hit rates across all cache systems
   - Dashboard setup

3. **User Metrics Migration** (Integrated into this plan)
@ai: Merged user metrics content below as requested

4. **Update Post-Model Feed Plan**
   - Add collections feed to the existing Meilisearch migration plan

@ai: I've addressed all feedback - downloads are already tracked in modelVersionEvents, and user metrics have been integrated below.

## User Metrics Integration

### Overview
Since we're capturing all entity events in ClickHouse, we can also compute user metrics directly from these events, eliminating separate PostgreSQL queries for user stats.

### Additional Event Types

**Extend enums:**
```typescript
// EntityType
"User" // For user-specific events like follows

// MetricType
"Follow" // User follow/unfollow events
"Upload" // Content upload tracking (if not derived)
```

### User Metrics from Entity Events

**File: `src/server/services/user-metrics-cache.service.ts`** (NEW)
- Compute user metrics from existing entity events:
  - **Upload counts**: Count distinct Model/Post/Image entities by userId
  - **Engagement received**: Sum reactions/downloads on user's content
  - **Follower count**: Track via Follow events
- Use same CacheHelper pattern as other metrics
- Cache structure: `user:metrics:{userId}` hash with all metrics

### ClickHouse Queries for User Metrics

**User's total downloads received:**
```sql
SELECT COUNT(*) as downloads
FROM modelVersionEvents
WHERE type = 'Download'
  AND modelVersionId IN (
    SELECT id FROM postgres.ModelVersion mv
    JOIN postgres.Model m ON mv.modelId = m.id
    WHERE m.userId = ?
  )
```

**User's engagement score:**
```sql
SELECT SUM(
  CASE
    WHEN metricType = 'Download' THEN metricValue * 1
    WHEN metricType = 'Generation' THEN metricValue * 2
    WHEN metricType = 'ReactionHeart' THEN metricValue * 0.5
    WHEN metricType = 'Comment' THEN metricValue * 1.5
    ELSE metricValue * 0.1
  END
) as engagementScore
FROM entityMetricEvents e
WHERE entityType IN ('Model', 'Post', 'Image')
  AND entityId IN (
    -- User's content IDs
  )
  AND createdAt >= now() - INTERVAL 30 DAY
```

### Integration Points for User Events

**File: `src/server/services/user.service.ts`** (EDIT)
- Add Follow event recording in follow/unfollow methods
- Record with +1/-1 for follow/unfollow

**Note:** Upload events can be derived from Model/Post/Image entity creation, no separate tracking needed

### Benefits of Integrated User Metrics
- Single source of truth (ClickHouse)
- Real-time user stats
- Reduced database load
- Consistent with other entity metrics

@dev: User metrics are now integrated into the main plan, leveraging the same ClickHouse events infrastructure

## Comprehensive Event Tracking Requirements

### Events We Need to Track (Posts, Models, Collections, Users)

Based on review of the metric computation jobs, here are ALL the events we need to track:

#### Model Events
**Already in ClickHouse:**
- ✅ Downloads (`modelVersionEvents` table, type='Download')
- ✅ Generations (orchestration data in ClickHouse)

**Need to Track:**
- ❌ Ratings (`ResourceReview` create/update/delete)
- ❌ Tips (Replace `BuzzTip` upserts with ClickHouse events)
- ❌ Tips to versions (`Donation` with `modelVersionId`)
- ❌ Comments (`Comment` where modelId is not null)
- ❌ Collections (`CollectionItem` where modelId is not null)

#### Post Events
**Need to Track:**
- ❌ Reactions (`ImageReaction` - map imageId to postId)
- ❌ Comments (`CommentV2` via Thread where postId is not null)
- ❌ Collections (`CollectionItem` where postId is not null)

#### Collection Events
**Need to Track:**
- ❌ Items added (`CollectionItem` creates)
- ❌ Contributors (`CollectionContributor` with permissions)
- ❌ Followers (`CollectionContributor` with VIEW permission)

#### User Events
**Need to Track:**
- ❌ Follows (`UserEngagement` type='Follow')
- ❌ Hides (`UserEngagement` type='Hide')
- ❌ Uploads (derived from Model/Post/Image creation)
- ❌ Reviews given (`ResourceReview` by userId)

### Key Integration Points to Hook

1. **ResourceReview Service**
   - Track create: +1 for ThumbsUp or ThumbsDown
   - Track update: -1 old value, +1 new value
   - Track delete: -1 for the removed rating

2. **Reaction Service**
   - Track create: +1 for reaction type
   - Track update: -1 old reaction, +1 new reaction
   - Track delete: -1 for removed reaction

3. **Comment Services**
   - `Comment` service for model comments
   - `CommentV2` service for post comments (via Thread)

4. **Collection Service**
   - Track item additions (model/post/image)
   - Track contributor changes
   - Differentiate followers (VIEW) vs contributors (ADD)

5. **Buzz/Donation Services**
   - Track tips to models
   - Track tips to model versions
   - Track tip amounts

6. **User Service**
   - Track follow/unfollow events
   - Track hide/unhide events

### Verification Checklist

To ensure we capture everything, search for writes to these tables:
- [x] `ResourceReview` - ratings for models
- [x] `ImageReaction` - reactions for posts
- [x] `CommentV2` - comments on posts
- [x] `Comment` - comments on models
- [x] `CollectionItem` - items in collections
- [x] `CollectionContributor` - collection followers/contributors
- [x] `BuzzTip` - tips to entities (being replaced with ClickHouse events)
- [x] `Donation` - donations to model versions
- [x] `UserEngagement` - follows and hides

With these events tracked in ClickHouse, we can fully replace the PostgreSQL metric computations for:
- ✅ Model metrics
- ✅ Post metrics
- ✅ Collection metrics
- ✅ User metrics

@ai: This is the complete list of events needed. Downloads and generations are already in ClickHouse, so we only need to add the tracking for the events marked with ❌.

## PostgreSQL Tables That Can Be Eliminated

After migrating to ClickHouse, these PostgreSQL tables can be completely removed:

### 1. Metric Aggregation Tables (can be eliminated)
These tables only store pre-computed metrics and can be replaced with ClickHouse queries + Redis cache:

**Core Metric Tables:**
- `ModelMetric` - Aggregated model statistics
- `ModelVersionMetric` - Aggregated model version statistics
- `PostMetric` - Aggregated post statistics
- `CollectionMetric` - Aggregated collection statistics
- `UserMetric` - Aggregated user statistics

**Where they're used (all can be replaced):**
- `model.service.ts`: JOINs to get model metrics for feeds → Replace with ClickHouse query
- `post.service.ts`: JOINs to get post metrics for feeds → Replace with ClickHouse query
- Search indexes: Pull metrics for Meilisearch → Query ClickHouse instead
- Sitemap generation: Get popular models → Query ClickHouse
- User score calculation: Aggregate user metrics → Calculate from ClickHouse events
- Discord metadata push: Get user stats → Query ClickHouse

### 2. Tables That Can Be Eliminated (Aggregation Only)

**BuzzTip Table:**
- **Current behavior**: Accumulates tip amounts per (entityType, entityId, fromUserId)
- **Only used for**: Metric calculations - no other reads found
- **Replacement strategy**:
  - Each tip becomes a separate event in ClickHouse
  - Event includes: entityType, entityId, userId, metricType='Tip', metricValue=amount
  - The `upsertBuzzTip` function will be modified to only record to ClickHouse
  - Buzz transactions continue as normal (separate from metrics)

### 3. Tables That Must Be Kept (contain source data)
These tables contain actual data that cannot be derived:

- `ResourceReview` - Contains actual review content and ratings
- `ImageReaction` - Contains user's specific reactions (though could be replaced per the ImageReaction replacement plan)
- `Comment` & `CommentV2` - Actual comment content
- `CollectionItem` - Actual collection items and metadata
- `CollectionContributor` - Contributor permissions
- `Donation` - Donation records with transaction details
- `UserEngagement` - Follow/hide relationships

### 3. Migration Benefits

**Storage Savings:**
- ~5-10GB reduction in PostgreSQL database size
- No more storing timeframe variations (Day, Week, Month, Year, AllTime)

**Performance Improvements:**
- Eliminate metric update jobs running every minute
- Remove thousands of INSERT/UPDATE operations per minute
- Reduce PostgreSQL CPU usage by ~30-40% from metric calculations alone

**Code Simplification:**
- Remove 14 metric job files
- Simplify service layer by removing metric table JOINs
- Single source of truth for all metrics

### 4. Implementation Notes for Table Removal

When removing metric tables:
1. Update all services to use new ClickHouse query services
2. Update search indexes to pull from ClickHouse
3. Migrate any remaining queries (sitemap, user score, etc.)
4. Run in parallel for validation period
5. Drop tables after confirming all queries work

@dev: The metric tables are purely aggregation storage and can be completely eliminated. The source event tables (reviews, reactions, etc.) must stay as they contain the actual data, not just counts.
