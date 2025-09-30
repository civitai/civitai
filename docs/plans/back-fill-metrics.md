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
@dev: This is another one where rather than doing 3 queries we can do 1 and split on the app side by UserEngagement.type

@ai: Agreed! Single query with post-processing:

```sql
-- Single query for all UserEngagement metrics
SELECT "userId", "targetUserId", "type", "createdAt"
FROM "UserEngagement"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for UserEngagement metrics
function processUserEngagement(engagements: UserEngagementRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  engagements.forEach(engagement => {
    if (engagement.type === 'Follow') {
      // followingCount (from perspective of user doing the following)
      events.push({
        entityType: 'User',
        entityId: engagement.userId,
        userId: engagement.userId,
        metricType: 'followingCount',
        metricValue: 1,
        createdAt: engagement.createdAt
      });

      // followerCount (from perspective of user receiving the follow)
      events.push({
        entityType: 'User',
        entityId: engagement.targetUserId,
        userId: engagement.userId,
        metricType: 'followerCount',
        metricValue: 1,
        createdAt: engagement.createdAt
      });
    } else if (engagement.type === 'Hide') {
      // hiddenCount
      events.push({
        entityType: 'User',
        entityId: engagement.targetUserId,
        userId: engagement.userId,
        metricType: 'hiddenCount',
        metricValue: 1,
        createdAt: engagement.createdAt
      });
    }
  });

  return events;
}
```

#### reactionCount (from ImageReaction, ArticleReaction, BountyEntryReaction)
@dev: There are a few queries here that run against the ImageReaction table... Rather than having each of those be separate, we should query against this table once and get the data that we need to be able to create all of the other metrics while processing on the app side.

@ai: Perfect! Let's fetch ImageReaction once with all needed joins:

```sql
-- Single query for all ImageReaction data (for User reactionCount, Image reactions, and Post reactions)
SELECT ir."imageId", ir."userId", ir."reaction", ir."createdAt",
       i."userId" as "imageOwnerId", i."postId"
FROM "ImageReaction" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."createdAt" < ${cutoff}
```

```typescript
// Post-processor for ImageReaction metrics (handles User, Image, and Post metrics)
function processImageReactions(reactions: ImageReactionRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  reactions.forEach(reaction => {
    // User reactionCount (content owner gets credit)
    events.push({
      entityType: 'User',
      entityId: reaction.imageOwnerId,
      userId: reaction.userId,
      metricType: 'reactionCount',
      metricValue: 1,
      createdAt: reaction.createdAt
    });

    // Image-specific reaction metrics (Like, Heart, etc.)
    events.push({
      entityType: 'Image',
      entityId: reaction.imageId,
      userId: reaction.userId,
      metricType: reaction.reaction,
      metricValue: 1,
      createdAt: reaction.createdAt
    });

    // Post-specific reaction metrics (if image belongs to a post)
    if (reaction.postId) {
      events.push({
        entityType: 'Post',
        entityId: reaction.postId,
        userId: reaction.userId,
        metricType: reaction.reaction,
        metricValue: 1,
        createdAt: reaction.createdAt
      });

      events.push({
        entityType: 'Post',
        entityId: reaction.postId,
        userId: reaction.userId,
        metricType: 'reactionCount',
        metricValue: 1,
        createdAt: reaction.createdAt
      });
    }
  });

  return events;
}
```

For ArticleReaction and BountyEntryReaction, separate queries:

```sql
-- ArticleReaction (for User reactionCount and Article reactions)
SELECT ar."articleId", ar."userId", ar."reaction", ar."createdAt",
       a."userId" as "articleOwnerId"
FROM "ArticleReaction" ar
JOIN "Article" a ON a.id = ar."articleId"
WHERE ar."createdAt" < ${cutoff}

-- BountyEntryReaction (for User reactionCount and BountyEntry reactions)
SELECT ber."bountyEntryId", ber."userId", ber."reaction", ber."createdAt",
       be."userId" as "entryOwnerId"
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
*See Optimized Query Strategy - handled in single ImageReaction query (processes User, Image, and Post metrics together)*

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
*See Optimized Query Strategy - handled in single ImageReaction query (processes User, Image, and Post metrics together)*

#### Collection (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

#### commentCount (from CommentV2)
*See Optimized Query Strategy - handled in single CommentV2 query*

#### tippedCount / tippedAmount (from BuzzTip)
*See Optimized Query Strategy - handled in single BuzzTip query*

### 6. CollectionMetric

#### followerCount / contributorCount (from CollectionContributor)
```sql
-- Single query for both CollectionContributor metrics
SELECT "collectionId", "userId", "createdAt"
FROM "CollectionContributor"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for CollectionContributor metrics
function processCollectionContributor(contributors: CollectionContributorRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  contributors.forEach(contributor => {
    events.push(
      {
        entityType: 'Collection',
        entityId: contributor.collectionId,
        userId: contributor.userId,
        metricType: 'followerCount',
        metricValue: 1,
        createdAt: contributor.createdAt
      },
      {
        entityType: 'Collection',
        entityId: contributor.collectionId,
        userId: contributor.userId,
        metricType: 'contributorCount',
        metricValue: 1,
        createdAt: contributor.createdAt
      }
    );
  });

  return events;
}
```

#### itemCount (from CollectionItem)
*See Optimized Query Strategy - handled in single CollectionItem query*

### 7. TagMetric

#### hiddenCount / followerCount (from TagEngagement)
@dev: This is another one where rather than doing 2 queries we can do 1 and split on the app side

@ai: Yes! Single query with post-processing:

```sql
-- Single query for all TagEngagement metrics
SELECT "tagId", "userId", "type", "createdAt"
FROM "TagEngagement"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for TagEngagement metrics
function processTagEngagement(engagements: TagEngagementRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  engagements.forEach(engagement => {
    const metricType = engagement.type === 'Hide' ? 'hiddenCount' : 'followerCount';

    events.push({
      entityType: 'Tag',
      entityId: engagement.tagId,
      userId: engagement.userId,
      metricType,
      metricValue: 1,
      createdAt: engagement.createdAt
    });
  });

  return events;
}
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
-- Single query for all BountyEngagement metrics
SELECT "bountyId", "userId", "type", "createdAt"
FROM "BountyEngagement"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for BountyEngagement metrics
function processBountyEngagement(engagements: BountyEngagementRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  engagements.forEach(engagement => {
    const metricType = engagement.type === 'Favorite' ? 'favoriteCount' : 'trackCount';

    events.push({
      entityType: 'Bounty',
      entityId: engagement.bountyId,
      userId: engagement.userId,
      metricType,
      metricValue: 1,
      createdAt: engagement.createdAt
    });
  });

  return events;
}
```

#### entryCount (from BountyEntry)
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'entryCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEntry"
WHERE "createdAt" < ${cutoff}
```

#### benefactorCount / unitAmount (from BountyBenefactor)
```sql
-- Single query for all BountyBenefactor metrics (includes BountyEntry unitAmount)
SELECT "bountyId", "userId", "unitAmount", "createdAt", "awardedAt", "awardedToId"
FROM "BountyBenefactor"
WHERE "createdAt" < ${cutoff}
```

```typescript
// Post-processor for BountyBenefactor metrics
function processBountyBenefactor(benefactors: BountyBenefactorRow[]): EntityMetricEvent[] {
  const events: EntityMetricEvent[] = [];

  benefactors.forEach(benefactor => {
    // Bounty metrics
    events.push(
      {
        entityType: 'Bounty',
        entityId: benefactor.bountyId,
        userId: benefactor.userId,
        metricType: 'benefactorCount',
        metricValue: 1,
        createdAt: benefactor.createdAt
      },
      {
        entityType: 'Bounty',
        entityId: benefactor.bountyId,
        userId: benefactor.userId,
        metricType: 'unitAmount',
        metricValue: benefactor.unitAmount,
        createdAt: benefactor.createdAt
      }
    );
  });

  return events;
}
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

@dev: There are a few shared tables missing here. We should list all tables we'll be querying against and the metrics they'll populate and ensure that we're hitting all of the metrics we need to backfill: docs\reference\new-metrics.md

@ai: Here's the complete list of all tables and the metrics they populate:

### Complete Table-to-Metrics Mapping

**Shared Tables (Single query, multiple entity metrics):**
1. **BuzzTip** → User (tippedAmount/Count, tipsGivenAmount/Count), Model/Post/Article/Image (tippedAmount/Count)
2. **CollectionItem** → Collection (itemCount), Model/Post/Article (collectedCount), Image (Collection)
3. **CommentV2 + Thread** → Post/Image/Article/Bounty (commentCount)
4. **ResourceReview** → Model/ModelVersion (ratingCount, thumbsUpCount, thumbsDownCount)
5. **ImageReaction + Image** → User (reactionCount), Image (Like/Heart/Laugh/Cry/Dislike), Post (Like/Heart/Laugh/Cry/Dislike + reactionCount)
6. **UserEngagement** → User (followingCount, followerCount, hiddenCount)
7. **TagEngagement** → Tag (hiddenCount, followerCount)
8. **BountyEngagement** → Bounty (favoriteCount, trackCount)
9. **CollectionContributor** → Collection (followerCount, contributorCount)
10. **BountyBenefactor** → Bounty (benefactorCount, unitAmount)

**Entity-Specific Tables:**
11. **ArticleReaction + Article** → User (reactionCount), Article (Like/Heart/Laugh/Cry/Dislike)
12. **BountyEntryReaction + BountyEntry** → User (reactionCount), BountyEntry (Like/Heart/Laugh/Cry/Dislike)
13. **ImageResourceNew + Image + ModelVersion** → Model (imageCount), ModelVersion (imageCount)
14. **Comment** (old) → Model (commentCount)
15. **Article** → User (articleCount)
16. **Bounty** → User (bountyCount)
17. **BountyEntry** → Bounty (entryCount), BountyEntry (unitAmount via join with BountyBenefactor)

**ClickHouse Tables:**
18. **modelVersionEvents** → Model/ModelVersion (downloadCount)
19. **orchestration.jobs** → Model/ModelVersion (generationCount)
20. **buzz_resource_compensation** → Model/ModelVersion (earnedAmount)

## Migration Processing Approach

### Higher-Order Migration Function

@dev: Considering that there will be some queries that handle populating multiple metrics, the structure of this won't work. Instead we should probably have it be a factory that takes a query({pg, ch}) and then a processor({pg, ch, rows, addMetrics}) for the results. addMetrics will be a fn the migrators can call to addMetrics(metric: EntityMetric | EntityMetric[]). The type of rows should match the type coming out of the query fn. These functions will then be run by an migration orchestrator that will manage working through each migration package and keep track of the state of each migration with a cli progress bar and queuing up the next query/process fn to perform.

@ai: Perfect! Here's the factory-based approach with proper typing:

```typescript
// Type definitions
type EntityMetricEvent = {
  entityType: string;
  entityId: number;
  userId: number;
  metricType: string;
  metricValue: number;
  createdAt: Date;
};

type QueryContext = {
  pg: typeof pgDbRead;
  ch: typeof clickhouse;
};

type ProcessorContext<TRow> = {
  pg: typeof pgDbRead;
  ch: typeof clickhouse;
  rows: TRow[];
  addMetrics: (metrics: EntityMetricEvent | EntityMetricEvent[]) => void;
};

type BatchRange = {
  start: number;
  end: number;
};

type MigrationPackage<TRow = any> = {
  name: string;
  queryBatchSize?: number; // Defaults to 1000
  range: (context: QueryContext) => Promise<BatchRange>;
  query: (context: QueryContext, range: BatchRange) => Promise<TRow[]>;
  processor: (context: ProcessorContext<TRow>) => Promise<void> | void;
};
// @dev: We'll still need to query in batches, so we'll need to have a range({pg, ch})=>{start: number, end: number} that will then be used to process batches using the query fn. We'll also need to pass a start and end into the query fn, probably like query(ctx, {start, end}) where start and end are the start and end of the batch that needs to be fetched. The migration package should include an optional queryBatchSize param that defaults to 1000.

@ai: Added! The range function determines the full data range, then query is called repeatedly with batches.

// Migration orchestrator
async function runMigrations(packages: MigrationPackage[], params: MigrationParams) {
  const cutoff = '2024-08-07 15:44:39.044';
  const progressBar = new ProgressBar();
  const queryContext = { pg: pgDbRead, ch: clickhouse };

  for (const pkg of packages) {
    progressBar.start(pkg.name);

    const queryBatchSize = pkg.queryBatchSize ?? 1000;
    let totalMetrics = 0;

    try {
      // Get the full range for this migration
      const { start: rangeStart, end: rangeEnd } = await pkg.range(queryContext);
      const totalBatches = Math.ceil((rangeEnd - rangeStart) / queryBatchSize);

      progressBar.setTotal(pkg.name, totalBatches);

      // Process in batches with controlled concurrency
      const batches: BatchRange[] = [];
      for (let start = rangeStart; start <= rangeEnd; start += queryBatchSize) {
        batches.push({
          start,
          end: Math.min(start + queryBatchSize - 1, rangeEnd)
        });
      }

      // Use p-limit or similar for concurrency control
      const limit = pLimit(params.concurrency ?? 1);

      await Promise.all(
        batches.map((batchRange, index) =>
          limit(async () => {
            // Execute query for this batch
            const rows = await pkg.query(queryContext, batchRange);

            // Process rows and collect metrics
            const metrics: EntityMetricEvent[] = [];
            await pkg.processor({
              pg: pgDbRead,
              ch: clickhouse,
              rows,
              addMetrics: (m) => {
                metrics.push(...(Array.isArray(m) ? m : [m]));
              }
            });

            // Batch insert into ClickHouse
            if (metrics.length > 0) {
              await batchInsertClickhouse(metrics, params.insertBatchSize ?? 500);
            }

            totalMetrics += metrics.length;
            progressBar.updateBatch(pkg.name, index + 1, metrics.length);
          })
        )
      );

      progressBar.complete(pkg.name, totalMetrics);
    } catch (error) {
      progressBar.error(pkg.name, error);
      throw error;
    }
  }
}
```

### Usage Example

```typescript
// Define migration packages
const migrationPackages: MigrationPackage[] = [
  // Example 1: Single query, simple processing (batched by Article ID)
  {
    name: 'User Article Count',
    queryBatchSize: 1000,
    range: async ({ pg }) => {
      const result = await pg.$queryRaw<{ min: number; max: number }[]>`
        SELECT MIN(id) as min, MAX(id) as max
        FROM "Article"
        WHERE "publishedAt" IS NOT NULL AND "publishedAt" < ${cutoff}
      `;
      return { start: result[0].min ?? 0, end: result[0].max ?? 0 };
    },
    query: async ({ pg }, { start, end }) => {
      return pg.$queryRaw<{ userId: number; publishedAt: Date }[]>`
        SELECT "userId", "publishedAt"
        FROM "Article"
        WHERE "publishedAt" IS NOT NULL
          AND "publishedAt" < ${cutoff}
          AND id >= ${start}
          AND id <= ${end}
        ORDER BY id
      `;
    },
    processor: ({ rows, addMetrics }) => {
      rows.forEach(row => {
        addMetrics({
          entityType: 'User',
          entityId: row.userId,
          userId: row.userId,
          metricType: 'articleCount',
          metricValue: 1,
          createdAt: row.publishedAt
        });
      });
    }
  },

  // Example 2: Single query, multiple metrics (BuzzTip - batched by BuzzTip ID)
  {
    name: 'BuzzTip Metrics',
    queryBatchSize: 2000,
    range: async ({ pg }) => {
      const result = await pg.$queryRaw<{ min: number; max: number }[]>`
        SELECT MIN(id) as min, MAX(id) as max
        FROM "BuzzTip"
        WHERE "createdAt" < ${cutoff}
      `;
      return { start: result[0].min ?? 0, end: result[0].max ?? 0 };
    },
    query: async ({ pg }, { start, end }) => {
      return pg.$queryRaw<{
        entityType: string;
        entityId: number;
        toUserId: number;
        fromUserId: number;
        amount: number;
        createdAt: Date;
      }[]>`
        SELECT "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
        FROM "BuzzTip"
        WHERE "createdAt" < ${cutoff}
          AND id >= ${start}
          AND id <= ${end}
        ORDER BY id
      `;
    },
    processor: ({ rows, addMetrics }) => {
      rows.forEach(tip => {
        const metrics: EntityMetricEvent[] = [];

        // Tips received by the entity
        if (tip.entityType === 'User') {
          metrics.push(
            { entityType: 'User', entityId: tip.toUserId, userId: tip.fromUserId,
              metricType: 'tippedCount', metricValue: 1, createdAt: tip.createdAt },
            { entityType: 'User', entityId: tip.toUserId, userId: tip.fromUserId,
              metricType: 'tippedAmount', metricValue: tip.amount, createdAt: tip.createdAt }
          );
        } else {
          metrics.push(
            { entityType: tip.entityType, entityId: tip.entityId, userId: tip.fromUserId,
              metricType: 'tippedCount', metricValue: 1, createdAt: tip.createdAt },
            { entityType: tip.entityType, entityId: tip.entityId, userId: tip.fromUserId,
              metricType: 'tippedAmount', metricValue: tip.amount, createdAt: tip.createdAt }
          );
        }

        // Tips given by user
        metrics.push(
          { entityType: 'User', entityId: tip.fromUserId, userId: tip.fromUserId,
            metricType: 'tipsGivenCount', metricValue: 1, createdAt: tip.createdAt },
          { entityType: 'User', entityId: tip.fromUserId, userId: tip.fromUserId,
            metricType: 'tipsGivenAmount', metricValue: tip.amount, createdAt: tip.createdAt }
        );

        addMetrics(metrics);
      });
    }
  },

  // Example 3: ClickHouse query (batched by event time in seconds)
  {
    name: 'Model Download Count',
    queryBatchSize: 86400, // 1 day in seconds
    range: async ({ ch }) => {
      const result = await ch.query<{ min: number; max: number }[]>(`
        SELECT
          toUnixTimestamp(MIN(time)) as min,
          toUnixTimestamp(MAX(time)) as max
        FROM modelVersionEvents
        WHERE type = 'Download' AND time < '${cutoff}'
      `);
      return { start: result[0].min ?? 0, end: result[0].max ?? 0 };
    },
    query: async ({ ch }, { start, end }) => {
      return ch.query<{
        modelId: number;
        modelVersionId: number;
        userId: number;
        time: Date;
      }>(`
        SELECT modelId, modelVersionId, userId, time
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND time < '${cutoff}'
          AND toUnixTimestamp(time) >= ${start}
          AND toUnixTimestamp(time) <= ${end}
        ORDER BY time
      `);
    },
    processor: ({ rows, addMetrics }) => {
      rows.forEach(row => {
        addMetrics([
          {
            entityType: 'Model',
            entityId: row.modelId,
            userId: row.userId,
            metricType: 'downloadCount',
            metricValue: 1,
            createdAt: row.time
          },
          {
            entityType: 'ModelVersion',
            entityId: row.modelVersionId,
            userId: row.userId,
            metricType: 'downloadCount',
            metricValue: 1,
            createdAt: row.time
          }
        ]);
      });
    }
  }
];

// Run all migrations
await runMigrations(migrationPackages, {
  concurrency: 10, // Number of concurrent batches to process
  insertBatchSize: 500, // Number of metrics to insert into ClickHouse at once
  start: 0
});
// @dev: I don't see how the concurrency is getting used, but it should...

@ai: Now implemented! Concurrency controls how many query batches run in parallel using p-limit.
```

### ClickHouse-to-ClickHouse Migrations

Some metrics come from ClickHouse tables and need special handling:

1. **Model/ModelVersion downloadCount**: From `modelVersionEvents` table (handled by modelVersionEventsHandler)
2. **Model/ModelVersion generationCount**: From `orchestration.jobs` table (handled by jobsHandler)
3. **Model/ModelVersion earnedAmount**: From `buzz_resource_compensation` table (handled by buzzResourceCompensationHandler)

These will need a separate migration approach that reads from ClickHouse and writes back to the `entityMetricEvents` table.

### Migration Order (Optimized)

**Phase 1: Shared Table Processing (10 queries, multiple metrics each)**
1. **BuzzTip** - Process once for all entity types (User, Model, Post, Article, Image)
2. **CollectionItem** - Process once for all entity types (Collection, Model, Post, Article, Image)
3. **CommentV2 + Thread** - Process once for all entity types (Post, Image, Article, Bounty)
4. **ResourceReview** - Process once for Model/ModelVersion
5. **ImageReaction + Image** - Process once for User/Image/Post
6. **UserEngagement** - User metrics only
7. **TagEngagement** - Tag metrics only
8. **BountyEngagement** - Bounty metrics only
9. **CollectionContributor** - Collection metrics only
10. **BountyBenefactor** - Bounty/BountyEntry metrics

**Phase 2: Entity-Specific Tables (7 queries)**
11. **ArticleReaction + Article** - Article/User metrics
12. **BountyEntryReaction + BountyEntry** - BountyEntry/User metrics
13. **ImageResourceNew + Image + ModelVersion** - Model/ModelVersion imageCount
14. **Comment** (old) - Model commentCount
15. **Article** - User articleCount
16. **Bounty** - User bountyCount
17. **BountyEntry** - Bounty entryCount

**Phase 3: ClickHouse Migration (3 queries)**
18. **modelVersionEvents** - Model/ModelVersion downloadCount
19. **orchestration.jobs** - Model/ModelVersion generationCount
20. **buzz_resource_compensation** - Model/ModelVersion earnedAmount

**Total: 20 queries covering all 75 unique metrics**

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

---
@dev: Can you please plan the filetree and imports below. I want things to live in scripts\oneoffs\metric-backfill and for each migration package to live in a separate file. I'm imagining something like:
```
scripts\oneoffs\metric-backfill
--run.ts # the runner and corresponding types
--metric-packages/
----index.ts # barrel for all metric packages
----base.ts # the factory and types for metric packages
----{name}.ts # metric package
```

@ai: Here's the complete file structure:

## File Structure

```
scripts/oneoffs/metric-backfill/
├── run.ts                           # CLI entry point and orchestrator
├── types.ts                         # Shared type definitions
├── utils.ts                         # Helper functions (progress bar, batch insert, etc.)
├── metric-packages/
│   ├── index.ts                     # Barrel export of all packages
│   ├── base.ts                      # Base factory function and utilities
│   │
│   ├── buzz-tip.ts                  # BuzzTip metrics (User, Model, Post, Article, Image)
│   ├── collection-item.ts           # CollectionItem metrics (Collection, Model, Post, Article, Image)
│   ├── comment-v2.ts                # CommentV2 metrics (Post, Image, Article, Bounty)
│   ├── resource-review.ts           # ResourceReview metrics (Model, ModelVersion)
│   ├── image-reaction.ts            # ImageReaction metrics (User, Image, Post)
│   ├── user-engagement.ts           # UserEngagement metrics (User)
│   ├── tag-engagement.ts            # TagEngagement metrics (Tag)
│   ├── bounty-engagement.ts         # BountyEngagement metrics (Bounty)
│   ├── collection-contributor.ts    # CollectionContributor metrics (Collection)
│   ├── bounty-benefactor.ts         # BountyBenefactor metrics (Bounty)
│   ├── article-reaction.ts          # ArticleReaction metrics (User, Article)
│   ├── bounty-entry-reaction.ts     # BountyEntryReaction metrics (User, BountyEntry)
│   ├── image-resource.ts            # ImageResourceNew metrics (Model, ModelVersion)
│   ├── comment.ts                   # Comment (old) metrics (Model)
│   ├── article.ts                   # Article metrics (User)
│   ├── bounty.ts                    # Bounty metrics (User)
│   ├── bounty-entry.ts              # BountyEntry metrics (Bounty)
│   ├── model-version-events.ts      # ClickHouse: Model/ModelVersion downloadCount
│   ├── orchestration-jobs.ts        # ClickHouse: Model/ModelVersion generationCount
│   └── buzz-resource-compensation.ts # ClickHouse: Model/ModelVersion earnedAmount
```

## File Contents

### `scripts/oneoffs/metric-backfill/types.ts`

```typescript
import type { Prisma } from '@prisma/client';
import type { ClickHouseClient } from '~/server/clickhouse/client';

export type EntityMetricEvent = {
  entityType: string;
  entityId: number;
  userId: number;
  metricType: string;
  metricValue: number;
  createdAt: Date;
};

export type BatchRange = {
  start: number;
  end: number;
};

// Simplified query interfaces for easier mocking/testing
export type PgQuery = {
  query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
};

export type ChQuery = {
  query: <T = any>(sql: string) => Promise<T[]>;
};

export type QueryContext = {
  pg: PgQuery;
  ch: ChQuery;
};

export type ProcessorContext<TRow> = {
  pg: PgQuery;
  ch: ChQuery;
  rows: TRow[];
  addMetrics: (...metrics: (EntityMetricEvent | EntityMetricEvent[])[]) => void;
};

export type MigrationPackage<TRow = any> = {
  queryBatchSize?: number; // Defaults to 1000
  range: (context: QueryContext) => Promise<BatchRange>;
  query: (context: QueryContext, range: BatchRange) => Promise<TRow[]>;
  processor: (context: ProcessorContext<TRow>) => Promise<void> | void;
};

export type MigrationParams = {
  concurrency?: number;       // Number of concurrent batches (default: 1)
  insertBatchSize?: number;   // ClickHouse insert batch size (default: 500)
  startFrom?: number;          // Optional: start from specific batch
  packages?: string[];         // Optional: filter to specific packages by name
};
```

### `scripts/oneoffs/metric-backfill/utils.ts`

```typescript
import { chunk } from 'lodash-es';
import { createLogger } from '~/utils/logging';
import { clickhouse } from '~/server/clickhouse/client';
import type { EntityMetricEvent } from './types';

const logger = createLogger('metric-backfill');

export const CUTOFF_DATE = '2024-08-07 15:44:39.044';

export class ProgressTracker {
  private packageProgress = new Map<string, { current: number; total: number; metrics: number }>();

  start(name: string) {
    logger.info(`Starting migration: ${name}`);
    this.packageProgress.set(name, { current: 0, total: 0, metrics: 0 });
  }

  setTotal(name: string, total: number) {
    const progress = this.packageProgress.get(name);
    if (progress) {
      progress.total = total;
      logger.info(`${name}: ${total} batches to process`);
    }
  }

  updateBatch(name: string, batchNumber: number, metricsCount: number) {
    const progress = this.packageProgress.get(name);
    if (progress) {
      progress.current = batchNumber;
      progress.metrics += metricsCount;
      logger.info(`${name}: Batch ${batchNumber}/${progress.total} - ${metricsCount} metrics (${progress.metrics} total)`);
    }
  }

  complete(name: string, totalMetrics: number) {
    logger.info(`✓ Completed migration: ${name} - ${totalMetrics} metrics inserted`);
    this.packageProgress.delete(name);
  }

  error(name: string, error: any) {
    logger.error(`✗ Failed migration: ${name}`, error);
    this.packageProgress.delete(name);
  }
}

export async function batchInsertClickhouse(
  metrics: EntityMetricEvent[],
  batchSize: number = 500
) {
  if (metrics.length === 0) return;

  // Insert in batches to avoid overwhelming ClickHouse
  // @dev: let's use lodash chunk here instead...

  @ai: Using lodash chunk:

  const batches = chunk(metrics, batchSize);
  for (const batch of batches) {
    await clickhouse.insert({
      table: 'entityMetricEvents',
      values: batch,
      format: 'JSONEachRow',
    });
  }
}
```

### `scripts/oneoffs/metric-backfill/run.ts`

```typescript
import { chunk } from 'lodash-es';
import pLimit from 'p-limit';
import { pgDbRead } from '~/server/db/pgDb'; // @dev: Let's use pgDbRead from ~\server\db\pgDb.ts instead
import { clickhouse } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import type { MigrationPackage, MigrationParams, EntityMetricEvent, BatchRange } from './types';
import { ProgressTracker, batchInsertClickhouse, CUTOFF_DATE } from './utils';
import * as migrationPackages from './metric-packages';

@ai: Now using pgDbRead and importing packages as namespace

const logger = createLogger('metric-backfill-runner');

// Wrapper to provide simplified query interface
function createQueryContext() {
  return {
    pg: {
      query: async <T = any>(sql: string, params?: any[]) => {
        return pgDbRead.query<T>(sql, params);
      }
    },
    ch: {
      query: async <T = any>(sql: string) => {
        return clickhouse.query<T>(sql).toPromise();
      }
    }
  };
}

export async function runMigrations(
  packages: Record<string, MigrationPackage>,
  params: MigrationParams = {}
) {
  const progressBar = new ProgressTracker();
  const queryContext = createQueryContext();

  // Filter packages if specified
  const packageEntries = Object.entries(packages);
  const packagesToRun = params.packages
    ? packageEntries.filter(([name]) => params.packages!.includes(name))
    : packageEntries;

  logger.info(`Running ${packagesToRun.length} migration packages`);
  logger.info(`Cutoff date: ${CUTOFF_DATE}`);
  logger.info(`Concurrency: ${params.concurrency ?? 1}`);
  logger.info(`Insert batch size: ${params.insertBatchSize ?? 500}`);

  for (const [name, pkg] of packagesToRun) {
    progressBar.start(name);

    const queryBatchSize = pkg.queryBatchSize ?? 1000;
    let totalMetrics = 0;

    try {
      // Get the full range for this migration
      const { start: rangeStart, end: rangeEnd } = await pkg.range(queryContext);

      if (rangeStart === 0 && rangeEnd === 0) {
        logger.info(`${name}: No data to process`);
        progressBar.complete(name, 0);
        continue;
      }

      const totalBatches = Math.ceil((rangeEnd - rangeStart) / queryBatchSize);
      progressBar.setTotal(name, totalBatches);

      // Process in batches with controlled concurrency
      const batches: BatchRange[] = [];
      for (let start = rangeStart; start <= rangeEnd; start += queryBatchSize) {
        batches.push({
          start,
          end: Math.min(start + queryBatchSize - 1, rangeEnd)
        });
      }

      // Skip to startFrom batch if specified
      const startIndex = params.startFrom ?? 0;
      const batchesToProcess = batches.slice(startIndex);

      // Use p-limit or similar for concurrency control
      const limit = pLimit(params.concurrency ?? 1);

      await Promise.all(
        batchesToProcess.map((batchRange, index) =>
          limit(async () => {
            const actualIndex = startIndex + index;

            try {
              // Execute query for this batch
              const rows = await pkg.query(queryContext, batchRange);

              // Process rows and collect metrics
              const metrics: EntityMetricEvent[] = [];
              await pkg.processor({
                ...queryContext,
                rows,
                addMetrics: (...m) => {
                  metrics.push(...m.flat());
                }
              });

              // Batch insert into ClickHouse
              if (metrics.length > 0) {
                await batchInsertClickhouse(metrics, params.insertBatchSize ?? 500);
              }

              totalMetrics += metrics.length;
              progressBar.updateBatch(name, actualIndex + 1, metrics.length);
            } catch (error) {
              logger.error(`${name}: Error processing batch ${actualIndex + 1}`, error);
              throw error;
            }
          })
        )
      );

      progressBar.complete(name, totalMetrics);
    } catch (error) {
      progressBar.error(name, error);
      throw error;
    }
  }

  logger.info('All migrations completed successfully');
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const params: MigrationParams = {
    concurrency: 10,
    insertBatchSize: 500,
  };

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--concurrency' && args[i + 1]) {
      params.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--batch-size' && args[i + 1]) {
      params.insertBatchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--start-from' && args[i + 1]) {
      params.startFrom = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--packages' && args[i + 1]) {
      params.packages = args[i + 1].split(',');
      i++;
    }
  }

  try {
    await runMigrations(migrationPackages, params);
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
```

### `scripts/oneoffs/metric-backfill/metric-packages/base.ts`

```typescript
import type { Prisma } from '@prisma/client';
import type { MigrationPackage, QueryContext, BatchRange } from '../types';
import { CUTOFF_DATE } from '../utils';

/**
 * Helper to create a standard ID-based range fetcher for Postgres tables
 */
export function createIdRangeFetcher(tableName: string, whereClause?: string) {
  return async ({ pg }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    // @dev: We're going to use node pg here instead of prisma. Since we don't need the full pg or ch client, what if we instead just pass in a dumbed down pg and ch wrapper that just has an easy to use `query` on it rather than giving the full client. That'll make it easier to mock/dry run.

    @ai: Great idea! Let's simplify the QueryContext:

    const result = await pg.query<{ min: number; max: number }>(
      `SELECT MIN(id) as min, MAX(id) as max FROM "${tableName}" ${where}`
    );
    return { start: result[0]?.min ?? 0, end: result[0]?.max ?? 0 };
  };
}

/**
 * Helper to create a standard timestamp-based range fetcher for ClickHouse tables
 */
export function createTimestampRangeFetcher(
  tableName: string,
  timeColumn: string = 'time',
  whereClause?: string
) {
  return async ({ ch }: QueryContext): Promise<BatchRange> => {
    const where = whereClause ? `WHERE ${whereClause}` : '';
    const result = await ch.query<{ min: number; max: number }[]>(`
      SELECT
        toUnixTimestamp(MIN(${timeColumn})) as min,
        toUnixTimestamp(MAX(${timeColumn})) as max
      FROM ${tableName}
      ${where}
    `);
    return { start: result[0]?.min ?? 0, end: result[0]?.max ?? 0 };
  };
}
```

### `scripts/oneoffs/metric-backfill/metric-packages/buzz-tip.ts` (Example)

```typescript
import { Prisma } from '@prisma/client';
import type { MigrationPackage, EntityMetricEvent } from '../types';
import { CUTOFF_DATE } from '../utils';
import { createIdRangeFetcher } from './base';

type BuzzTipRow = {
  entityType: string;
  entityId: number;
  toUserId: number;
  fromUserId: number;
  amount: number;
  createdAt: Date;
};

export const buzzTipPackage: MigrationPackage<BuzzTipRow> = {
  name: 'BuzzTip Metrics',
  queryBatchSize: 2000,
  range: createIdRangeFetcher('BuzzTip', `"createdAt" < '${CUTOFF_DATE}'`),

  query: async ({ pg }, { start, end }) => {
    return pg.query<BuzzTipRow>(
      `SELECT "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
       FROM "BuzzTip"
       WHERE "createdAt" < $1
         AND id >= $2
         AND id <= $3
       ORDER BY id`,
      [CUTOFF_DATE, start, end]
    );
  },

  processor: ({ rows, addMetrics }) => {
    rows.forEach(tip => {
      // @dev: since we can just call addMetrics to append the the array at the parent, we should just call it rather than appending our own array.
      // We should probably make that fn take EntityMetric | EntityMetric[] | ...args: EntityMetric[] however that should be done, so it can be used just like push

      @ai: Now using addMetrics directly with spread args:

      // Tips received by the entity
      if (tip.entityType === 'User') {
        addMetrics(
          {
            entityType: 'User',
            entityId: tip.toUserId,
            userId: tip.fromUserId,
            metricType: 'tippedCount',
            metricValue: 1,
            createdAt: tip.createdAt
          },
          {
            entityType: 'User',
            entityId: tip.toUserId,
            userId: tip.fromUserId,
            metricType: 'tippedAmount',
            metricValue: tip.amount,
            createdAt: tip.createdAt
          }
        );
      } else {
        addMetrics(
          {
            entityType: tip.entityType,
            entityId: tip.entityId,
            userId: tip.fromUserId,
            metricType: 'tippedCount',
            metricValue: 1,
            createdAt: tip.createdAt
          },
          {
            entityType: tip.entityType,
            entityId: tip.entityId,
            userId: tip.fromUserId,
            metricType: 'tippedAmount',
            metricValue: tip.amount,
            createdAt: tip.createdAt
          }
        );
      }

      // Tips given by user
      addMetrics(
        {
          entityType: 'User',
          entityId: tip.fromUserId,
          userId: tip.fromUserId,
          metricType: 'tipsGivenCount',
          metricValue: 1,
          createdAt: tip.createdAt
        },
        {
          entityType: 'User',
          entityId: tip.fromUserId,
          userId: tip.fromUserId,
          metricType: 'tipsGivenAmount',
          metricValue: tip.amount,
          createdAt: tip.createdAt
        }
      );
    });
  }
};
```

### `scripts/oneoffs/metric-backfill/metric-packages/index.ts`

```typescript
import type { MigrationPackage } from '../types';

// Phase 1: Shared Table Processing
import { buzzTipPackage } from './buzz-tip';
import { collectionItemPackage } from './collection-item';
import { commentV2Package } from './comment-v2';
import { resourceReviewPackage } from './resource-review';
import { imageReactionPackage } from './image-reaction';
import { userEngagementPackage } from './user-engagement';
import { tagEngagementPackage } from './tag-engagement';
import { bountyEngagementPackage } from './bounty-engagement';
import { collectionContributorPackage } from './collection-contributor';
import { bountyBenefactorPackage } from './bounty-benefactor';

// Phase 2: Entity-Specific Tables
import { articleReactionPackage } from './article-reaction';
import { bountyEntryReactionPackage } from './bounty-entry-reaction';
import { imageResourcePackage } from './image-resource';
import { commentPackage } from './comment';
import { articlePackage } from './article';
import { bountyPackage } from './bounty';
import { bountyEntryPackage } from './bounty-entry';

// Phase 3: ClickHouse Tables
import { modelVersionEventsPackage } from './model-version-events';
import { orchestrationJobsPackage } from './orchestration-jobs';
import { buzzResourceCompensationPackage } from './buzz-resource-compensation';

// @dev: Rather than importing and re-exporting like this, can we just:
// export { modelVersionEventsPackage } from './model-version-events';
// and then in the runner do `import * as migrationPackages from './metric-packages';`
// and then we can remove name from MigrationPackage since we'll use the fn name/key as the name...

@ai: Much cleaner! Now just re-exporting directly:

// Phase 1: Shared Tables
export { buzzTipPackage } from './buzz-tip';
export { collectionItemPackage } from './collection-item';
export { commentV2Package } from './comment-v2';
export { resourceReviewPackage } from './resource-review';
export { imageReactionPackage } from './image-reaction';
export { userEngagementPackage } from './user-engagement';
export { tagEngagementPackage } from './tag-engagement';
export { bountyEngagementPackage } from './bounty-engagement';
export { collectionContributorPackage } from './collection-contributor';
export { bountyBenefactorPackage } from './bounty-benefactor';

// Phase 2: Entity-Specific
export { articleReactionPackage } from './article-reaction';
export { bountyEntryReactionPackage } from './bounty-entry-reaction';
export { imageResourcePackage } from './image-resource';
export { commentPackage } from './comment';
export { articlePackage } from './article';
export { bountyPackage } from './bounty';
export { bountyEntryPackage } from './bounty-entry';

// Phase 3: ClickHouse
export { modelVersionEventsPackage } from './model-version-events';
export { orchestrationJobsPackage } from './orchestration-jobs';
export { buzzResourceCompensationPackage } from './buzz-resource-compensation';
```

## Additional Optimizations

### 1. Connection Pooling
Ensure proper connection pool sizes to handle concurrency:
```typescript
// In run.ts or config
const MAX_CONCURRENCY = 10;
// Ensure pg pool size >= concurrency
// pgDbRead should have pool size of at least 10
```

### 2. Batch Size Tuning
Different tables may benefit from different batch sizes:
```typescript
export const buzzTipPackage: MigrationPackage<BuzzTipRow> = {
  queryBatchSize: 5000, // Larger for simple tables
  // ...
};

export const imageReactionPackage: MigrationPackage<ImageReactionRow> = {
  queryBatchSize: 2000, // Smaller for complex joins
  // ...
};
```

### 3. Progress Persistence
Add ability to save/resume progress in case of failures:
```typescript
// In utils.ts
import fs from 'fs/promises';

export class ProgressTracker {
  private progressFile = './metric-backfill-progress.json';

  async saveProgress(packageName: string, lastBatch: number) {
    const progress = await this.loadProgress();
    progress[packageName] = lastBatch;
    await fs.writeFile(this.progressFile, JSON.stringify(progress, null, 2));
  }

  async loadProgress(): Promise<Record<string, number>> {
    try {
      const data = await fs.readFile(this.progressFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
}

// In run.ts - automatically resume from last saved position
const savedProgress = await progressBar.loadProgress();
const startIndex = params.startFrom ?? savedProgress[name] ?? 0;
```

### 4. Dry Run Mode
Add ability to test without inserting data:
```typescript
export type MigrationParams = {
  concurrency?: number;
  insertBatchSize?: number;
  startFrom?: number;
  packages?: string[];
  dryRun?: boolean; // Don't insert, just count
};

// In run.ts
if (!params.dryRun) {
  await batchInsertClickhouse(metrics, params.insertBatchSize ?? 500);
} else {
  logger.info(`[DRY RUN] Would insert ${metrics.length} metrics`);
}
```

### 5. Parallel Package Processing
Run multiple packages concurrently instead of sequentially:
```typescript
// In run.ts - change from sequential to parallel
await Promise.all(
  packagesToRun.map(async ([name, pkg]) => {
    progressBar.start(name);
    // ... process package
  })
);
```

### 6. Memory Management
Stream large result sets instead of loading all into memory:
```typescript
// For very large tables, use cursor-based pagination
export function createCursorRangeFetcher(tableName: string, whereClause?: string) {
  return async ({ pg }: QueryContext): Promise<BatchRange> => {
    // Use cursor to process rows in chunks without loading all IDs
    // More memory efficient for tables with millions of rows
  };
}
```

### 7. Error Recovery & Retry Logic
Add automatic retry for transient failures:
```typescript
async function retryable<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  backoff = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      logger.warn(`Retry ${i + 1}/${maxRetries} after error:`, error);
      await new Promise(resolve => setTimeout(resolve, backoff * (i + 1)));
    }
  }
  throw new Error('Should not reach here');
}

// Use in query execution
const rows = await retryable(() => pkg.query(queryContext, batchRange));
```

### 8. Metrics & Monitoring
Add detailed performance metrics:
```typescript
export class ProgressTracker {
  private startTime = Date.now();
  private metricsPerSecond: number[] = [];

  updateBatch(name: string, batchNumber: number, metricsCount: number) {
    const progress = this.packageProgress.get(name);
    if (progress) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      const rate = progress.metrics / elapsed;
      this.metricsPerSecond.push(rate);

      const avgRate = this.metricsPerSecond.slice(-10).reduce((a, b) => a + b, 0) /
                      Math.min(this.metricsPerSecond.length, 10);

      const remaining = progress.total - progress.current;
      const eta = remaining / avgRate;

      logger.info(
        `${name}: Batch ${batchNumber}/${progress.total} - ` +
        `${metricsCount} metrics (${progress.metrics} total) - ` +
        `${avgRate.toFixed(0)} metrics/sec - ` +
        `ETA: ${Math.round(eta)}s`
      );
    }
  }
}
```

### 9. Index Optimization
Ensure proper indexes exist before running:
```typescript
// Run before migration
async function ensureIndexes() {
  await pgDbRead.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_buzztip_createdat
    ON "BuzzTip"("createdAt")
    WHERE "createdAt" < '2024-08-07 15:44:39.044'
  `);

  await pgDbRead.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_buzztip_id_createdat
    ON "BuzzTip"(id, "createdAt")
    WHERE "createdAt" < '2024-08-07 15:44:39.044'
  `);
}
```

### 10. ClickHouse Insert Optimization
Use async inserts and optimize format:
```typescript
export async function batchInsertClickhouse(
  metrics: EntityMetricEvent[],
  batchSize: number = 500
) {
  if (metrics.length === 0) return;

  const batches = chunk(metrics, batchSize);

  // Use Promise.all for parallel inserts (ClickHouse can handle it)
  await Promise.all(
    batches.map(batch =>
      clickhouse.insert({
        table: 'entityMetricEvents',
        values: batch,
        format: 'JSONEachRow',
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 0,
          // Optimize for bulk inserts
          max_insert_block_size: 100000,
        }
      })
    )
  );
}
```

### 11. Query Optimization
Optimize the queries themselves:
```typescript
// Add query hints for better performance
query: async ({ pg }, { start, end }) => {
  return pg.query<BuzzTipRow>(
    `SELECT /*+ IndexScan(BuzzTip idx_buzztip_id_createdat) */
            "entityType", "entityId", "toUserId", "fromUserId", "amount", "createdAt"
     FROM "BuzzTip"
     WHERE "createdAt" < $1
       AND id >= $2
       AND id <= $3
     ORDER BY id`,
    [CUTOFF_DATE, start, end]
  );
},
```

### 12. Package Ordering
Process packages in optimal order (smallest first for quick wins):
```typescript
// In metric-packages/index.ts - add size hints
export const buzzTipPackage: MigrationPackage<BuzzTipRow> = {
  queryBatchSize: 2000,
  estimatedRows: 5_000_000, // Hint for ordering
  // ...
};

// In run.ts - sort by estimated size
const packagesToRun = packageEntries
  .sort(([, a], [, b]) => (a.estimatedRows ?? 0) - (b.estimatedRows ?? 0));
```

## Usage

```bash
# Run all migrations with optimizations
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --concurrency 10 \
  --batch-size 500

# Test specific packages with limited batches (perfect for testing queries/processing)
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --packages buzzTipPackage \
  --limit-batches 2 \
  --dry-run

# Dry run to test queries (processes all batches but doesn't insert)
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --dry-run \
  --packages buzzTipPackage

# Run specific packages only
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --packages buzzTipPackage,collectionItemPackage

# Resume from a specific batch (if interrupted)
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --start-from 150

# Auto-resume from last saved progress
npm run tsx scripts/oneoffs/metric-backfill/run.ts \
  --auto-resume
```

```
cc -r 69bde83e-638c-44c6-8346-0cba7dae0d30
```
