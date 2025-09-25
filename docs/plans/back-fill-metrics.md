As part of this project, docs\plans\debezium.md, We are migrating all metrics. And what that means is we need to backfill ClickHouse with the data necessary to get the correct metric values. To do this, we need to look at each metric processor in this folder: src\server\metrics, carefully review each of the queries that are running against ClickHouse or Postgres, and identify what we need to do to write entity metric events to ClickHouse in a way that corresponds with the values that we are pulling in those queries.

We've already gone through this process for image metrics, and here's the script we prepared for that:
src\pages\api\admin\temp\migrate-img-metrics.ts

You'll see there how we turn records in the DB into events to insert into ClickHouse.

For now, outline the query needed for each of the entityTypes and their corresponding metricTypes. Ensure you don't miss any by checking against the list in debezium.md (you can ignore deprecated or metrics driven by the outbox). Then outline how you will process the migration following the example of the migrate-img-metrics.ts, with a single example, or even better, a higher order function that systematizes the process.

@dev: We've spent a bunch of time working on this metric engine as we originally outlined in the debuseum.md. And now we've got a new set of metrics. I'd like to have your help in revising this plan to align with those new metrics. Here are the new metrics: docs\reference\new-metrics.md

@ai: I've reviewed the new metrics from docs\reference\new-metrics.md and updated this plan to align with the 75 unique metrics across 21 handlers. The main changes are:
1. Removed deprecated metrics (rating, favoriteCount on models, etc.)
2. Added new User metrics (articleCount, bountyCount, tipsGivenAmount/Count)
3. Updated reaction metrics to use proper metric names (Like, Heart, etc. instead of likeCount)
4. Added missing entities like BountyEntry reactions
5. Aligned table names with actual schema (ImageResourceNew instead of ImageResource)

## Entity Metric Events Backfill Plan

Based on the new metrics from docs\reference\new-metrics.md (75 unique metrics across 21 handlers) and the existing image migration example, here are all the metrics that need to be backfilled to ClickHouse:

### 1. UserMetric

#### followingCount / followerCount / hiddenCount (from UserEngagement)
```sql
-- followingCount (from perspective of user doing the following)
SELECT 'User' as "entityType", "userId" as "entityId", "userId", 'followingCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}

-- followerCount (from perspective of user receiving the follow)
SELECT 'User' as "entityType", "targetUserId" as "entityId", "userId", 'followerCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}

-- hiddenCount
SELECT 'User' as "entityType", "targetUserId" as "entityId", "userId", 'hiddenCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Hide' AND "createdAt" < ${cutoff}
```

#### reactionCount (from ImageReaction, ArticleReaction, BountyEntryReaction)
```sql
-- From image reactions (content owner gets credit)
SELECT 'User' as "entityType", i."userId" as "entityId", ir."userId", 'reactionCount' as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageReaction" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."createdAt" < ${cutoff}

-- From article reactions
SELECT 'User' as "entityType", a."userId" as "entityId", ar."userId", 'reactionCount' as "metricType", 1 as "metricValue", ar."createdAt"
FROM "ArticleReaction" ar
JOIN "Article" a ON a.id = ar."articleId"
WHERE ar."createdAt" < ${cutoff}

-- From bounty entry reactions
SELECT 'User' as "entityType", be."userId" as "entityId", ber."userId", 'reactionCount' as "metricType", 1 as "metricValue", ber."createdAt"
FROM "BountyEntryReaction" ber
JOIN "BountyEntry" be ON be.id = ber."bountyEntryId"
WHERE ber."createdAt" < ${cutoff}
```

#### tippedAmount / tippedCount / tipsGivenAmount / tipsGivenCount (from BuzzTip)
@dev: If there is a way to backfill multiple metrics with a single query, like with tip count and tip amount, let's do it in a single query and then do prep at the app layer with a query post processor that splits them into separate entityMetricEvents, since effectively all of the queries below could be accomplished with a single query

@ai: Absolutely! Here's the optimized single query approach with post-processing:

```sql
-- Single query to fetch all BuzzTip data
SELECT "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
FROM "BuzzTip"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor to generate multiple metric events from each row
function processBuzzTips(tips: BuzzTipRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  tips.forEach(tip => {
    // Tips received by the entity
    if (tip.entityType === 'User') {
      events.push(
        { entityType: 'User', entityId: tip.toUserId, userId: tip.fromUserId,
          metricType: 'tippedCount', metricValue: 1, createdAt: tip.createdAt },
        { entityType: 'User', entityId: tip.toUserId, userId: tip.fromUserId,
          metricType: 'tippedAmount', metricValue: tip.amount, createdAt: tip.createdAt }
      );
    } else {
      // For Model, Post, Article, Image entities
      events.push(
        { entityType: tip.entityType, entityId: tip.entityId, userId: tip.fromUserId,
          metricType: 'tippedCount', metricValue: 1, createdAt: tip.createdAt },
        { entityType: tip.entityType, entityId: tip.entityId, userId: tip.fromUserId,
          metricType: 'tippedAmount', metricValue: tip.amount, createdAt: tip.createdAt }
      );
    }

    // Tips given by user
    events.push(
      { entityType: 'User', entityId: tip.fromUserId, userId: tip.fromUserId,
        metricType: 'tipsGivenCount', metricValue: 1, createdAt: tip.createdAt },
      { entityType: 'User', entityId: tip.fromUserId, userId: tip.fromUserId,
        metricType: 'tipsGivenAmount', metricValue: tip.amount, createdAt: tip.createdAt }
    );
  });

  return events;
}
```

#### articleCount (from Article)
```sql
SELECT 'User' as "entityType", "userId" as "entityId", "userId", 'articleCount' as "metricType", 1 as "metricValue", "publishedAt"
FROM "Article"
WHERE "publishedAt" IS NOT NULL AND "publishedAt" < ${cutoff}
```

#### bountyCount (from Bounty)
```sql
SELECT 'User' as "entityType", "userId" as "entityId", "userId", 'bountyCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "Bounty"
WHERE "createdAt" < ${cutoff}
```

### 2. ModelMetric

#### ratingCount / thumbsUpCount / thumbsDownCount (from ResourceReview)
*See Optimized Query Strategy - handled with ModelVersion in single ResourceReview query*

#### collectedCount (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

#### commentCount (from Comment - old table, not CommentV2)
```sql
SELECT 'Model' as "entityType", "modelId" as "entityId", "userId", 'commentCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "Comment"
WHERE "modelId" IS NOT NULL AND "createdAt" < ${cutoff}
```

#### imageCount (from ImageResourceNew)
```sql
SELECT 'Model' as "entityType", mv."modelId" as "entityId", i."userId", 'imageCount' as "metricType", 1 as "metricValue", i."createdAt"
FROM "ImageResourceNew" ir
JOIN "Image" i ON i.id = ir."imageId"
JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
WHERE i."createdAt" < ${cutoff}
```

#### tippedCount / tippedAmount (from BuzzTip)
*See Optimized Query Strategy - handled in single BuzzTip query*

#### downloadCount / generationCount / earnedAmount (from ClickHouse)
@dev: Please outline the clickhouse queries for this. The backfill tool should also handle clickhouse queries.

@ai: Here are the ClickHouse queries for Model/ModelVersion metrics:

```sql
-- downloadCount from modelVersionEvents
SELECT
  'Model' as entityType,
  modelId as entityId,
  userId,
  'downloadCount' as metricType,
  1 as metricValue,
  time as createdAt
FROM modelVersionEvents
WHERE type = 'Download' AND time < '${cutoff}'

SELECT
  'ModelVersion' as entityType,
  modelVersionId as entityId,
  userId,
  'downloadCount' as metricType,
  1 as metricValue,
  time as createdAt
FROM modelVersionEvents
WHERE type = 'Download' AND time < '${cutoff}'

-- generationCount from orchestration.jobs
SELECT
  'Model' as entityType,
  JSONExtractInt(params, 'modelId') as entityId,
  userId,
  'generationCount' as metricType,
  1 as metricValue,
  createdAt
FROM orchestration.jobs
WHERE type = 'GenerateImage'
  AND status = 'Completed'
  AND createdAt < '${cutoff}'

SELECT
  'ModelVersion' as entityType,
  JSONExtractInt(params, 'modelVersionId') as entityId,
  userId,
  'generationCount' as metricType,
  1 as metricValue,
  createdAt
FROM orchestration.jobs
WHERE type = 'GenerateImage'
  AND status = 'Completed'
  AND createdAt < '${cutoff}'

-- earnedAmount from buzz_resource_compensation
SELECT
  'Model' as entityType,
  modelId as entityId,
  toUserId as userId,
  'earnedAmount' as metricType,
  amount as metricValue,
  createdAt
FROM buzz_resource_compensation
WHERE modelId IS NOT NULL AND createdAt < '${cutoff}'

SELECT
  'ModelVersion' as entityType,
  modelVersionId as entityId,
  toUserId as userId,
  'earnedAmount' as metricType,
  amount as metricValue,
  createdAt
FROM buzz_resource_compensation
WHERE modelVersionId IS NOT NULL AND createdAt < '${cutoff}'
```

### 3. ModelVersionMetric

#### ratingCount / thumbsUpCount / thumbsDownCount (from ResourceReview)
@dev: If these can be handled at the same time as the model metrics for these, let's try and merge those.

@ai: Yes! Let's combine Model and ModelVersion metrics from ResourceReview in a single query:

```sql
-- Single query for all ResourceReview metrics (Model & ModelVersion)
SELECT "modelId", "modelVersionId", "userId", "recommended", "createdAt"
FROM "ResourceReview"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for ResourceReview metrics
function processResourceReviews(reviews: ResourceReviewRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  reviews.forEach(review => {
    // Model metrics
    if (review.modelId) {
      events.push(
        { entityType: 'Model', entityId: review.modelId, userId: review.userId,
          metricType: 'ratingCount', metricValue: 1, createdAt: review.createdAt }
      );

      if (review.recommended !== null) {
        events.push(
          { entityType: 'Model', entityId: review.modelId, userId: review.userId,
            metricType: review.recommended ? 'thumbsUpCount' : 'thumbsDownCount',
            metricValue: 1, createdAt: review.createdAt }
        );
      }
    }

    // ModelVersion metrics
    if (review.modelVersionId) {
      events.push(
        { entityType: 'ModelVersion', entityId: review.modelVersionId, userId: review.userId,
          metricType: 'ratingCount', metricValue: 1, createdAt: review.createdAt }
      );

      if (review.recommended !== null) {
        events.push(
          { entityType: 'ModelVersion', entityId: review.modelVersionId, userId: review.userId,
            metricType: review.recommended ? 'thumbsUpCount' : 'thumbsDownCount',
            metricValue: 1, createdAt: review.createdAt }
        );
      }
    }
  });

  return events;
}
```

#### imageCount (from ImageResourceNew)
```sql
SELECT 'ModelVersion' as "entityType", "modelVersionId" as "entityId", i."userId", 'imageCount' as "metricType", 1 as "metricValue", i."createdAt"
FROM "ImageResourceNew" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."modelVersionId" IS NOT NULL AND i."createdAt" < ${cutoff}
```

#### downloadCount / generationCount / earnedAmount (from ClickHouse)
```sql
-- These come from ClickHouse tables and will be handled in ClickHouse-to-ClickHouse migration:
-- downloadCount: from modelVersionEvents table
-- generationCount: from orchestration.jobs table
-- earnedAmount: from buzz_resource_compensation table
```

### 4. PostMetric

#### Like / Dislike / Laugh / Cry / Heart / reactionCount (from ImageReaction)
```sql
-- Individual reaction types
SELECT 'Post' as "entityType", i."postId" as "entityId", ir."userId",
       ir.reaction as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageReaction" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE i."postId" IS NOT NULL AND ir."createdAt" < ${cutoff}

-- reactionCount (total of all reactions)
SELECT 'Post' as "entityType", i."postId" as "entityId", ir."userId",
       'reactionCount' as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageReaction" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE i."postId" IS NOT NULL AND ir."createdAt" < ${cutoff}
```

#### commentCount (from CommentV2)
*See Optimized Query Strategy - handled in single CommentV2 query*

#### collectedCount (from CollectionItem)
@dev: Rather than doing a separate query for each type of CollectionItem, let's do a single query to go through collectionItems and then add a metric event depending on the collectedItem type

@ai: Great idea! Let's fetch all CollectionItems once and process them for all entity types:

```sql
-- Single query for all CollectionItem metrics
SELECT "collectionId", "articleId", "postId", "imageId", "modelId",
       "addedById", "createdAt"
FROM "CollectionItem"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for CollectionItem metrics
function processCollectionItems(items: CollectionItemRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  items.forEach(item => {
    // Collection itemCount metric
    events.push({
      entityType: 'Collection',
      entityId: item.collectionId,
      userId: item.addedById,
      metricType: 'itemCount',
      metricValue: 1,
      createdAt: item.createdAt
    });

    // Entity-specific collectedCount metrics
    if (item.modelId) {
      events.push({
        entityType: 'Model',
        entityId: item.modelId,
        userId: item.addedById,
        metricType: 'collectedCount',
        metricValue: 1,
        createdAt: item.createdAt
      });
    }

    if (item.postId) {
      events.push({
        entityType: 'Post',
        entityId: item.postId,
        userId: item.addedById,
        metricType: 'collectedCount',
        metricValue: 1,
        createdAt: item.createdAt
      });
    }

    if (item.articleId) {
      events.push({
        entityType: 'Article',
        entityId: item.articleId,
        userId: item.addedById,
        metricType: 'collectedCount',
        metricValue: 1,
        createdAt: item.createdAt
      });
    }

    if (item.imageId) {
      events.push({
        entityType: 'Image',
        entityId: item.imageId,
        userId: item.addedById,
        metricType: 'Collection',  // Note: Image uses 'Collection' not 'collectedCount'
        metricValue: 1,
        createdAt: item.createdAt
      });
    }
  });

  return events;
}
```

#### tippedCount / tippedAmount (from BuzzTip)
*See Optimized Query Strategy - handled in single BuzzTip query*

### 5. ImageMetric

#### Like / Dislike / Laugh / Cry / Heart (from ImageReaction)
```sql
SELECT 'Image' as "entityType", "imageId" as "entityId", "userId",
       reaction as "metricType", 1 as "metricValue", "createdAt"
FROM "ImageReaction"
WHERE "createdAt" < ${cutoff}
```

#### Collection (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

#### commentCount (from CommentV2)
*See Optimized Query Strategy - handled in single CommentV2 query*

#### tippedCount / tippedAmount (from BuzzTip)
*See Optimized Query Strategy - handled in single BuzzTip query*

### 6. CollectionMetric

#### followerCount / contributorCount (from CollectionContributor)
```sql
-- Both metrics come from the same table
SELECT 'Collection' as "entityType", "collectionId" as "entityId", "userId", 'followerCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionContributor"
WHERE "createdAt" < ${cutoff}

SELECT 'Collection' as "entityType", "collectionId" as "entityId", "userId", 'contributorCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionContributor"
WHERE "createdAt" < ${cutoff}
```

#### itemCount (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

### 7. TagMetric

#### hiddenCount / followerCount (from TagEngagement)
```sql
SELECT 'Tag' as "entityType", "tagId" as "entityId", "userId", 'hiddenCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "TagEngagement"
WHERE type = 'Hide' AND "createdAt" < ${cutoff}

SELECT 'Tag' as "entityType", "tagId" as "entityId", "userId", 'followerCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "TagEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}
```

### 8. ArticleMetric

#### Like / Dislike / Laugh / Cry / Heart (from ArticleReaction)
```sql
SELECT 'Article' as "entityType", "articleId" as "entityId", "userId",
       reaction as "metricType", 1 as "metricValue", "createdAt"
FROM "ArticleReaction"
WHERE "createdAt" < ${cutoff}
```

#### commentCount (from CommentV2)
@dev: let's see if we can get all comment metrics for every entity type in a single go with post processing

@ai: Yes! Let's combine all CommentV2 metrics across entity types:

```sql
-- Single query for all CommentV2 metrics
SELECT t."postId", t."imageId", t."articleId", t."bountyId",
       c."userId", c."createdAt"
FROM "CommentV2" c
JOIN "Thread" t ON c."threadId" = t.id
WHERE c."createdAt" < ${cutoff}
```

```typescript
// Post-processor for CommentV2 metrics
function processComments(comments: CommentRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  comments.forEach(comment => {
    if (comment.postId) {
      events.push({
        entityType: 'Post',
        entityId: comment.postId,
        userId: comment.userId,
        metricType: 'commentCount',
        metricValue: 1,
        createdAt: comment.createdAt
      });
    }

    if (comment.imageId) {
      events.push({
        entityType: 'Image',
        entityId: comment.imageId,
        userId: comment.userId,
        metricType: 'commentCount',
        metricValue: 1,
        createdAt: comment.createdAt
      });
    }

    if (comment.articleId) {
      events.push({
        entityType: 'Article',
        entityId: comment.articleId,
        userId: comment.userId,
        metricType: 'commentCount',
        metricValue: 1,
        createdAt: comment.createdAt
      });
    }

    if (comment.bountyId) {
      events.push({
        entityType: 'Bounty',
        entityId: comment.bountyId,
        userId: comment.userId,
        metricType: 'commentCount',
        metricValue: 1,
        createdAt: comment.createdAt
      });
    }
  });

  return events;
}
```

#### collectedCount (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

#### tippedCount / tippedAmount (from BuzzTip)
*See Optimized Query Strategy - handled in single BuzzTip query*

### 9. BountyMetric

#### favoriteCount / trackCount (from BountyEngagement)
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'favoriteCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEngagement"
WHERE type = 'Favorite' AND "createdAt" < ${cutoff}

SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'trackCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEngagement"
WHERE type = 'Track' AND "createdAt" < ${cutoff}
```

#### entryCount (from BountyEntry)
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'entryCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEntry"
WHERE "createdAt" < ${cutoff}
```

#### benefactorCount / unitAmount (from BountyBenefactor)
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'benefactorCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyBenefactor"
WHERE "createdAt" < ${cutoff}

SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'unitAmount' as "metricType", "unitAmount" as "metricValue", "createdAt"
FROM "BountyBenefactor"
WHERE "createdAt" < ${cutoff}
```

#### commentCount (from CommentV2)
*See Optimized Query Strategy - handled in single CommentV2 query*

### 10. BountyEntryMetric

#### Like / Dislike / Laugh / Cry / Heart (from BountyEntryReaction)
```sql
SELECT 'BountyEntry' as "entityType", "bountyEntryId" as "entityId", "userId",
       reaction as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEntryReaction"
WHERE "createdAt" < ${cutoff}
```

#### unitAmount (from BountyBenefactor when awarded)
```sql
SELECT 'BountyEntry' as "entityType", be."id" as "entityId", bb."userId", 'unitAmount' as "metricType", bb."unitAmount" as "metricValue", bb."awardedAt"
FROM "BountyEntry" be
JOIN "BountyBenefactor" bb ON bb."awardedToId" = be."userId" AND bb."bountyId" = be."bountyId"
WHERE bb."awardedAt" IS NOT NULL AND bb."awardedAt" < ${cutoff}
```

## Optimized Query Strategy

### Shared Tables Processing

Instead of running separate queries for each entity type, we'll use single queries for shared tables and post-process the results:

1. **BuzzTip** - Single query generates metrics for:
   - User: tippedCount, tippedAmount, tipsGivenCount, tipsGivenAmount
   - Model/Post/Article/Image: tippedCount, tippedAmount

2. **CollectionItem** - Single query generates metrics for:
   - Collection: itemCount
   - Model/Post/Article: collectedCount
   - Image: Collection

3. **CommentV2 + Thread** - Single query generates metrics for:
   - Post/Image/Article/Bounty: commentCount

4. **ResourceReview** - Single query generates metrics for:
   - Model/ModelVersion: ratingCount, thumbsUpCount, thumbsDownCount

5. **Comment** (old table) - Separate query for Model commentCount

## Migration Processing Approach

### Higher-Order Migration Function

```typescript
type MetricQuery = {
  entityType: string;
  metricType: string;
  sql: Prisma.Sql;
};

type MigrationConfig = {
  entityType: string;
  tableName: string;
  idColumn: string;
  queries: MetricQuery[];
};

async function migrateEntityMetrics(
  config: MigrationConfig,
  params: MigrationParams
) {
  const cutoff = '2024-08-07 15:44:39.044';
  const { entityType, tableName, idColumn, queries } = config;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      // Get max ID for the main table of this entity type
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("${Prisma.raw(idColumn)}") "max" FROM "${Prisma.raw(tableName)}";`
      );
      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      let data: QueryRes[] = [];

      // Execute all queries for this entity type in parallel
      const queryPromises = queries.map(async (query) => {
        const queryResult = await pgDbRead.cancellableQuery<QueryRes>(
          query.sql // Queries should handle their own range filtering
        );
        cancelFns.push(queryResult.cancel);
        return queryResult.result();
      });

      const results = await Promise.all(queryPromises);
      data = results.flat();

      // Transform data to ClickHouse format
      const events = data.map(row => ({
        entityType: row.entityType,
        entityId: row.entityId,
        userId: row.userId,
        metricType: row.metricType,
        metricValue: row.metricValue,
        createdAt: row.createdAt,
      }));

      // Insert into ClickHouse
      await insertClickhouse(events);

      console.log(`Processed ${entityType} metrics:`, data.length, 'events');
    },
  });
}
```

### Usage Example

```typescript
// Migrate User metrics
await migrateEntityMetrics(
  {
    entityType: 'User',
    tableName: 'User',
    idColumn: 'id',
    queries: [
      {
        entityType: 'User',
        metricType: 'followerCount',
        sql: Prisma.sql`
          SELECT 'User' as "entityType", "targetUserId" as "entityId",
                 "userId", 'followerCount' as "metricType", 1 as "metricValue", "createdAt"
          FROM "UserEngagement"
          WHERE type = 'Follow' AND "createdAt" < ${cutoff}
        `
      },
      {
        entityType: 'User',
        metricType: 'hiddenCount',
        sql: Prisma.sql`
          SELECT 'User' as "entityType", "targetUserId" as "entityId",
                 "userId", 'hiddenCount' as "metricType", 1 as "metricValue", "createdAt"
          FROM "UserEngagement"
          WHERE type = 'Hide' AND "createdAt" < ${cutoff}
        `
      },
      // ... more queries
    ]
  },
  { concurrency: 10, batchSize: 500, start: 0 }
);
```

### ClickHouse-to-ClickHouse Migrations

Some metrics come from ClickHouse tables and need special handling:

1. **Model/ModelVersion downloadCount**: From `modelVersionEvents` table (handled by modelVersionEventsHandler)
2. **Model/ModelVersion generationCount**: From `orchestration.jobs` table (handled by jobsHandler)
3. **Model/ModelVersion earnedAmount**: From `buzz_resource_compensation` table (handled by buzzResourceCompensationHandler)

These will need a separate migration approach that reads from ClickHouse and writes back to the `entityMetricEvents` table.

### Migration Order (Optimized)

**Phase 1: Shared Table Processing**
1. **BuzzTip** - Process once for all entity types
2. **CollectionItem** - Process once for all entity types
3. **CommentV2** - Process once for all entity types
4. **ResourceReview** - Process once for Model/ModelVersion

**Phase 2: Entity-Specific Tables**
5. **UserEngagement** - User metrics only
6. **ImageReaction** - Process for Image/Post/User
7. **ArticleReaction** - Article/User metrics
8. **BountyEntryReaction** - BountyEntry/User metrics
9. **ImageResourceNew** - Model/ModelVersion metrics
10. **Other entity-specific tables** - Process remaining metrics

**Phase 3: ClickHouse Migration**
11. **modelVersionEvents** - downloadCount
12. **orchestration.jobs** - generationCount
13. **buzz_resource_compensation** - earnedAmount

### Summary of Metric Alignment

The updated plan now aligns with the new metrics system (docs/reference/new-metrics.md):

**Key Changes from Original Plan:**
1. Removed deprecated metrics (rating values, favoriteCount, etc.)
2. Added new User metrics (articleCount, bountyCount, tipsGivenAmount/Count)
3. Updated reaction metric names to match handler output (Like, Heart, etc. instead of likeCount)
4. Corrected table references (ImageResourceNew instead of ImageResource, Comment vs CommentV2)
5. Added missing entities like BountyEntry reactions
6. Aligned all 75 unique metrics across 21 handlers

**Total Metrics to Backfill:**
- User: 10 metrics
- Model: 10 metrics
- ModelVersion: 7 metrics
- Post: 12 metrics
- Image: 9 metrics
- Collection: 3 metrics
- Tag: 2 metrics
- Article: 9 metrics
- Bounty: 6 metrics
- BountyEntry: 6 metrics
- **Total: 74 metrics** (Image.Collection counted separately)
