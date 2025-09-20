# User Metrics Migration to ClickHouse

## Executive Summary

Migrate user metrics computation from PostgreSQL aggregations to ClickHouse event-based calculations, leveraging the entity metrics events we're already capturing for posts, models, and collections.

## Current State

### Problems with Current Implementation
- Heavy PostgreSQL queries aggregating across multiple tables
- Runs every minute causing database load
- Complex joins across User, Model, Post, Image, Collection tables
- Slow ranking calculations
- No real-time metrics

### Current User Metrics
- Upload count (models, posts, images)
- Follower/following counts
- Total reactions received
- Total downloads/generations
- Engagement scores
- Rank calculations

## Proposed Architecture

### Leverage Existing Event Data

With the entity metrics migration, we'll have all necessary events in ClickHouse:
- Model uploads, downloads, ratings
- Post creations, reactions, comments
- Collection items, followers
- Image uploads, reactions
- User follows

### New Event Types Needed

**File: `src/shared/utils/prisma/enums.ts`**
Add to `EntityMetric_EntityType_Type`:
- `"User"` - For user-specific events

Add to `EntityMetric_MetricType_Type`:
- `"Follow"` - User follow events
- `"Upload"` - Content upload events
- `"Engagement"` - Aggregated engagement score

## Implementation Plan

### 1. Event Recording

**File: `src/server/services/user-metric-event.service.ts`** (NEW)
```typescript
class UserMetricEventService {
  // Record user follow/unfollow
  async recordFollow(followerId: number, userId: number, isFollow: boolean)

  // Record content upload (called from model/post/image creation)
  async recordUpload(userId: number, contentType: string)

  // Record engagement (aggregated from reactions received)
  async recordEngagement(userId: number, score: number)
}
```

### 2. Integration Points

**Track these user events:**

1. **Follow Events**
   - Location: User service follow/unfollow methods
   - Record: followerId -> userId relationships

2. **Upload Events**
   - Model creation: `model.service.ts`
   - Post creation: `post.service.ts`
   - Image upload: `image.service.ts`

3. **Engagement Calculation**
   - Derived from entity metrics
   - Calculate when reactions/downloads occur
   - Store aggregated score

### 3. Query Service

**File: `src/server/services/user-metrics-query.service.ts`** (NEW)
```typescript
class UserMetricsQueryService {
  // Get all user metrics
  async getUserMetrics(userIds: number[]): Promise<Map<number, UserMetrics>>

  // Get specific metric
  async getUserFollowerCount(userId: number): Promise<number>

  // Get user rank
  async getUserRank(userId: number): Promise<number>

  // Calculate engagement score from events
  async calculateEngagementScore(userId: number): Promise<number>
}
```

### 4. ClickHouse Queries

**Follower Count:**
```sql
SELECT
  entityId as userId,
  countIf(metricValue > 0) - countIf(metricValue < 0) as followerCount
FROM entityMetricEvents
WHERE entityType = 'User'
  AND metricType = 'Follow'
  AND entityId = ?
```

**Upload Counts:**
```sql
SELECT
  userId,
  countIf(entityType = 'Model') as modelCount,
  countIf(entityType = 'Post') as postCount,
  countIf(entityType = 'Image') as imageCount
FROM (
  SELECT DISTINCT userId, entityType, entityId
  FROM entityMetricEvents
  WHERE userId = ?
    AND metricType = 'Upload'
)
GROUP BY userId
```

**Engagement Score:**
```sql
SELECT
  m.userId,
  SUM(engagement_weight) as totalEngagement
FROM (
  SELECT
    userId,
    entityId,
    entityType,
    CASE
      WHEN metricType = 'Download' THEN metricValue * 1
      WHEN metricType = 'Generation' THEN metricValue * 2
      WHEN metricType = 'ReactionHeart' THEN metricValue * 0.5
      WHEN metricType = 'Comment' THEN metricValue * 1.5
      ELSE metricValue * 0.1
    END as engagement_weight
  FROM entityMetricEvents
  WHERE createdAt >= now() - INTERVAL 30 DAY
) e
JOIN models m ON m.id = e.entityId AND e.entityType = 'Model'
WHERE m.userId = ?
GROUP BY m.userId
```

### 5. Redis Cache Structure

**Cache Key Pattern:**
```
user:metrics:{userId} -> Hash
  followerCount: 1234
  followingCount: 567
  uploadCount: 89
  modelCount: 10
  postCount: 45
  imageCount: 34
  engagementScore: 9876
  rank: 123
```

**TTL:** 1 hour (refresh on demand)

### 6. Migration Strategy

#### Phase 1: Event Recording (Day 1)
- [ ] Add user event recording to all content creation
- [ ] Start recording follow events
- [ ] Begin dual-write to ClickHouse

#### Phase 2: Query Implementation (Day 2)
- [ ] Implement ClickHouse queries
- [ ] Add Redis caching layer
- [ ] Create comparison tools

#### Phase 3: Validation (Day 3)
- [ ] Compare ClickHouse vs PostgreSQL metrics
- [ ] Fix any discrepancies
- [ ] Performance testing

#### Phase 4: Cutover (Day 4)
- [ ] Switch reads to ClickHouse
- [ ] Monitor performance
- [ ] Remove old code

## Benefits

1. **Real-time Metrics**: Instant updates as events occur
2. **Performance**: 90% reduction in database load
3. **Scalability**: ClickHouse handles billions of events
4. **Flexibility**: Easy to add new metrics
5. **Historical Analysis**: Can query metrics over any time period

## Affected Components

### Files to Update
- `src/server/services/user.service.ts` - Add event recording
- `src/server/services/model.service.ts` - Record uploads
- `src/server/services/post.service.ts` - Record uploads
- `src/server/routers/user.router.ts` - Use new metrics service
- `src/pages/user/[username]/index.tsx` - Display metrics

### Jobs to Modify
- `src/server/jobs/update-user-metrics.ts` - Remove or simplify
- `src/server/jobs/update-user-ranks.ts` - Use ClickHouse data

## Success Metrics

1. All user metrics available in < 50ms
2. 90% reduction in user metric query load
3. Real-time metric updates (< 1 second delay)
4. Accurate historical metrics
5. Simplified codebase

## Future Enhancements

1. **Time-series Metrics**
   - Track user growth over time
   - Engagement trends
   - Activity patterns

2. **Advanced Analytics**
   - User cohort analysis
   - Retention metrics
   - Behavior patterns

3. **Personalized Insights**
   - Performance comparisons
   - Growth recommendations
   - Achievement tracking

@dev: This completes the metrics migration to ClickHouse. By moving user metrics, we'll have all major metric computations running on ClickHouse, dramatically reducing PostgreSQL load and enabling real-time analytics.