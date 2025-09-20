# ImageReaction Table Replacement with ClickHouse Events

## Executive Summary

Replace the PostgreSQL `ImageReaction` table with ClickHouse event storage and Redis caching, eliminating database overhead and improving reaction query performance.

## Current Problems

1. **Database Overhead**: ImageReaction table creates significant PostgreSQL load
2. **Storage Inefficiency**: Storing individual rows for each user-image-reaction combination
3. **Query Performance**: Fetching user reactions requires multiple database queries
4. **Consistency Issues**: Potential for race conditions during concurrent updates

## Proposed Architecture

### Data Storage

**ClickHouse**: Source of truth for all reaction events
- Already storing reaction events in `entityMetricEvents` table
- Can query user's reactions historically

**Redis Cache**: Fast access for active user sessions
- Key: `reactions:{userId}:{imageId}`
- Value: Bitwise flags representing reactions
- TTL: 7 days (refresh on access)

### Reaction Encoding (Bitwise)

```typescript
enum ReactionFlag {
  Like = 1 << 0,   // 1
  Heart = 1 << 1,  // 2
  Laugh = 1 << 2,  // 4
  Cry = 1 << 3,    // 8
}

// Example: User has Like + Heart = 3
// Example: User has all reactions = 15
```

## Implementation Plan

### Phase 1: Redis Cache Layer

**File: `src/server/services/user-reaction-cache.service.ts`** (NEW)
```typescript
class UserReactionCacheService {
  // Get user's reactions for multiple images
  async getUserReactions(userId: number, imageIds: number[]): Promise<Map<number, number>>

  // Set user's reaction for an image
  async setReaction(userId: number, imageId: number, reactions: number): Promise<void>

  // Clear user's reactions for an image
  async clearReaction(userId: number, imageId: number): Promise<void>

  // Populate cache from ClickHouse
  async populateFromClickHouse(userId: number, imageIds: number[]): Promise<void>
}
```

### Phase 2: Query Service

**File: `src/server/services/user-reaction-query.service.ts`** (NEW)
- Check Redis cache first
- On cache miss, query ClickHouse and populate cache
- Aggregate reaction events to current state
- Handle reaction changes (latest event wins)

### Phase 3: Migration Strategy

1. **Dual Read Phase** (Week 1)
   - Continue writing to ImageReaction table
   - Start populating Redis cache
   - Compare results for validation

2. **Switch Reads** (Week 2)
   - Route all reads through new service
   - Keep ImageReaction as fallback
   - Monitor performance

3. **Stop Writes** (Week 3)
   - Stop writing to ImageReaction table
   - Archive table data
   - Remove table references

## Technical Details

### Redis Operations

```typescript
// Get reactions for images
HMGET reactions:{userId} {imageId1} {imageId2} ...

// Set reaction
HSET reactions:{userId} {imageId} {reactionFlags}

// Clear reaction
HDEL reactions:{userId} {imageId}

// Set TTL
EXPIRE reactions:{userId} 604800
```

### ClickHouse Query

```sql
SELECT
  entityId as imageId,
  metricType,
  MAX(createdAt) as latestAction,
  SUM(metricValue) as totalValue
FROM entityMetricEvents
WHERE entityType = 'Image'
  AND userId = ?
  AND entityId IN (?)
  AND metricType IN ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry')
GROUP BY entityId, metricType
HAVING totalValue > 0
```

### API Changes

**Before:**
```typescript
// Multiple database queries
const reactions = await db.imageReaction.findMany({
  where: { userId, imageId: { in: imageIds } }
});
```

**After:**
```typescript
// Single cache lookup
const reactions = await userReactionCache.getUserReactions(userId, imageIds);
```

## Benefits

1. **Performance**: ~10ms cache lookups vs 50-100ms database queries
2. **Scalability**: Redis handles millions of concurrent reads
3. **Storage**: 80% reduction in storage requirements
4. **Simplicity**: No complex database transactions for reactions

## Migration Checklist

- [ ] Implement UserReactionCacheService
- [ ] Create ClickHouse query service
- [ ] Add cache population logic
- [ ] Update reaction endpoints to use new service
- [ ] Implement dual-read validation
- [ ] Switch all reads to new system
- [ ] Stop writes to ImageReaction table
- [ ] Archive and remove old table

## Success Metrics

- Cache hit rate > 95%
- Reaction query time < 10ms (p99)
- Zero data loss during migration
- 80% reduction in reaction-related database load

@dev: This plan eliminates the ImageReaction table entirely, using ClickHouse as the source of truth and Redis for fast access. The bitwise flags keep the cache compact and efficient.