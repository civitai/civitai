As part of this project, docs\plans\debezium.md, We are migrating all metrics. And what that means is we need to backfill ClickHouse with the data necessary to get the correct metric values. To do this, we need to look at each metric processor in this folder: src\server\metrics, carefully review each of the queries that are running against ClickHouse or Postgres, and identify what we need to do to write entity metric events to ClickHouse in a way that corresponds with the values that we are pulling in those queries.

We've already gone through this process for image metrics, and here's the script we prepared for that:
src\pages\api\admin\temp\migrate-img-metrics.ts

You'll see there how we turn records in the DB into events to insert into ClickHouse.

For now, outline the query needed for each of the entityTypes and their corresponding metricTypes. Ensure you don't miss any by checking against the list in debezium.md (you can ignore deprecated or metrics driven by the outbox). Then outline how you will process the migration following the example of the migrate-img-metrics.ts, with a single example, or even better, a higher order function that systematizes the process.

## Entity Metric Events Backfill Plan

Based on the debezium.md mapping and the existing image migration example, here are all the metrics that need to be backfilled to ClickHouse:

### 1. UserMetric

#### followingCount / followerCount
```sql
-- Following (from perspective of user doing the following)
SELECT 'User' as "entityType", "userId" as "entityId", "userId", 'Following' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}

-- Follower (from perspective of user receiving the follow)
SELECT 'User' as "entityType", "targetUserId" as "entityId", "userId", 'Follower' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}
```

#### hiddenCount
```sql
SELECT 'User' as "entityType", "targetUserId" as "entityId", "userId", 'Hidden' as "metricType", 1 as "metricValue", "createdAt"
FROM "UserEngagement"
WHERE type = 'Hide' AND "createdAt" < ${cutoff}
```

#### reactionCount
```sql
SELECT 'User' as "entityType", i."userId" as "entityId", ir."userId", 'UserImageReaction' as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageReaction" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."createdAt" < ${cutoff}
```

#### reviewCount
```sql
SELECT 'User' as "entityType", "userId" as "entityId", "userId", 'Review' as "metricType", 1 as "metricValue", "createdAt"
FROM "ResourceReview"
WHERE "createdAt" < ${cutoff}
```

### 2. ModelMetric

#### rating / ratingCount
```sql
SELECT 'Model' as "entityType", "modelId" as "entityId", "userId", 'Rating' as "metricType", rating as "metricValue", "createdAt"
FROM "ResourceReview"
WHERE "modelId" IS NOT NULL AND "createdAt" < ${cutoff}

SELECT 'Model' as "entityType", "modelId" as "entityId", "userId", 'RatingCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "ResourceReview"
WHERE "modelId" IS NOT NULL AND "createdAt" < ${cutoff}
```

#### downloadCount
```sql
-- This comes from ClickHouse modelVersionEvents, need to aggregate to model level
-- Will be handled separately in ClickHouse-to-ClickHouse migration
```

#### favoriteCount / collectedCount
```sql
SELECT 'Model' as "entityType", "modelId" as "entityId", "addedById" as "userId", 'Favorite' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "modelId" IS NOT NULL AND "createdAt" < ${cutoff}

SELECT 'Model' as "entityType", "modelId" as "entityId", "addedById" as "userId", 'Collection' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "modelId" IS NOT NULL AND "createdAt" < ${cutoff}
```

#### commentCount
```sql
SELECT 'Model' as "entityType", t."modelId" as "entityId", c."userId", 'Comment' as "metricType", 1 as "metricValue", c."createdAt"
FROM "Thread" t
JOIN "CommentV2" c ON c."threadId" = t.id
WHERE t."modelId" IS NOT NULL AND c."createdAt" < ${cutoff}
```

#### imageCount
```sql
SELECT 'Model' as "entityType", "modelId" as "entityId", i."userId", 'Image' as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageResource" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."modelId" IS NOT NULL AND ir."createdAt" < ${cutoff}
```

#### tippedCount / tippedAmountCount
```sql
SELECT 'Model' as "entityType", "entityId", "fromUserId" as "userId", 'TipCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'Model' AND "createdAt" < ${cutoff}

SELECT 'Model' as "entityType", "entityId", "fromUserId" as "userId", 'TipAmount' as "metricType", amount as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'Model' AND "createdAt" < ${cutoff}
```

#### thumbsUpCount / thumbsDownCount
```sql
SELECT 'Model' as "entityType", "modelId" as "entityId", "userId",
       CASE WHEN recommended = true THEN 'ThumbsUp' ELSE 'ThumbsDown' END as "metricType",
       1 as "metricValue", "createdAt"
FROM "ResourceReview"
WHERE "modelId" IS NOT NULL AND recommended IS NOT NULL AND "createdAt" < ${cutoff}
```

### 3. ModelVersionMetric

Similar to ModelMetric but with modelVersionId:

```sql
-- Rating metrics
SELECT 'ModelVersion' as "entityType", "modelVersionId" as "entityId", "userId", 'Rating' as "metricType", rating as "metricValue", "createdAt"
FROM "ResourceReview"
WHERE "modelVersionId" IS NOT NULL AND "createdAt" < ${cutoff}

-- Collection metrics
SELECT 'ModelVersion' as "entityType", "modelVersionId" as "entityId", "addedById" as "userId", 'Collection' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "modelVersionId" IS NOT NULL AND "createdAt" < ${cutoff}

-- Image metrics
SELECT 'ModelVersion' as "entityType", "modelVersionId" as "entityId", i."userId", 'Image' as "metricType", 1 as "metricValue", ir."createdAt"
FROM "ImageResource" ir
JOIN "Image" i ON i.id = ir."imageId"
WHERE ir."modelVersionId" IS NOT NULL AND ir."createdAt" < ${cutoff}

-- Tip metrics
SELECT 'ModelVersion' as "entityType", "entityId", "fromUserId" as "userId", 'TipCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'ModelVersion' AND "createdAt" < ${cutoff}
```

### 4. PostMetric

#### reaction metrics (like, dislike, laugh, cry, heart)
```sql
SELECT 'Post' as "entityType", p."id" as "entityId", ir."userId",
       concat('Reaction', ir.reaction) as "metricType", 1 as "metricValue", ir."createdAt"
FROM "Post" p
JOIN "Image" i ON i."postId" = p.id
JOIN "ImageReaction" ir ON ir."imageId" = i.id
WHERE ir."createdAt" < ${cutoff} AND ir.reaction IN ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart')
```

#### commentCount
```sql
SELECT 'Post' as "entityType", t."postId" as "entityId", c."userId", 'Comment' as "metricType", 1 as "metricValue", c."createdAt"
FROM "Thread" t
JOIN "CommentV2" c ON c."threadId" = t.id
WHERE t."postId" IS NOT NULL AND c."createdAt" < ${cutoff}
```

#### collectedCount
```sql
SELECT 'Post' as "entityType", "postId" as "entityId", "addedById" as "userId", 'Collection' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "postId" IS NOT NULL AND "createdAt" < ${cutoff}
```

### 5. ImageMetric (Already implemented in migrate-img-metrics.ts)

### 6. CollectionMetric

#### followerCount / contributorCount
```sql
SELECT 'Collection' as "entityType", "collectionId" as "entityId", "userId", 'Follower' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionContributor"
WHERE "createdAt" < ${cutoff}

SELECT 'Collection' as "entityType", "collectionId" as "entityId", "userId", 'Contributor' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionContributor"
WHERE "createdAt" < ${cutoff}
```

#### itemCount
```sql
SELECT 'Collection' as "entityType", "collectionId" as "entityId", "addedById" as "userId", 'Item' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "createdAt" < ${cutoff}
```

### 7. TagMetric

#### hiddenCount / followerCount
```sql
SELECT 'Tag' as "entityType", "tagId" as "entityId", "userId", 'Hidden' as "metricType", 1 as "metricValue", "createdAt"
FROM "TagEngagement"
WHERE type = 'Hide' AND "createdAt" < ${cutoff}

SELECT 'Tag' as "entityType", "tagId" as "entityId", "userId", 'Follower' as "metricType", 1 as "metricValue", "createdAt"
FROM "TagEngagement"
WHERE type = 'Follow' AND "createdAt" < ${cutoff}
```

### 8. ArticleMetric

#### reaction metrics
```sql
SELECT 'Article' as "entityType", "articleId" as "entityId", "userId",
       concat('Reaction', reaction) as "metricType", 1 as "metricValue", "createdAt"
FROM "ArticleReaction"
WHERE "createdAt" < ${cutoff} AND reaction IN ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart')
```

#### commentCount
```sql
SELECT 'Article' as "entityType", t."articleId" as "entityId", c."userId", 'Comment' as "metricType", 1 as "metricValue", c."createdAt"
FROM "Thread" t
JOIN "CommentV2" c ON c."threadId" = t.id
WHERE t."articleId" IS NOT NULL AND c."createdAt" < ${cutoff}
```

#### favoriteCount / collectedCount
```sql
SELECT 'Article' as "entityType", "articleId" as "entityId", "addedById" as "userId", 'Favorite' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "articleId" IS NOT NULL AND "createdAt" < ${cutoff}

SELECT 'Article' as "entityType", "articleId" as "entityId", "addedById" as "userId", 'Collection' as "metricType", 1 as "metricValue", "createdAt"
FROM "CollectionItem"
WHERE "articleId" IS NOT NULL AND "createdAt" < ${cutoff}
```

#### hideCount
```sql
SELECT 'Article' as "entityType", "articleId" as "entityId", "userId", 'Hide' as "metricType", 1 as "metricValue", "createdAt"
FROM "ArticleEngagement"
WHERE type = 'Hide' AND "createdAt" < ${cutoff}
```

#### tippedCount / tippedAmountCount
```sql
SELECT 'Article' as "entityType", "entityId", "fromUserId" as "userId", 'TipCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'Article' AND "createdAt" < ${cutoff}

SELECT 'Article' as "entityType", "entityId", "fromUserId" as "userId", 'TipAmount' as "metricType", amount as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'Article' AND "createdAt" < ${cutoff}
```

### 9. BountyMetric

#### favoriteCount / trackCount
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'Favorite' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEngagement"
WHERE type = 'Favorite' AND "createdAt" < ${cutoff}

SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'Track' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEngagement"
WHERE type = 'Track' AND "createdAt" < ${cutoff}
```

#### entryCount
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'Entry' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEntry"
WHERE "createdAt" < ${cutoff}
```

#### benefactorCount / unitAmountCount
```sql
SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'Benefactor' as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyBenefactor"
WHERE "createdAt" < ${cutoff}

SELECT 'Bounty' as "entityType", "bountyId" as "entityId", "userId", 'UnitAmount' as "metricType", "unitAmount" as "metricValue", "createdAt"
FROM "BountyBenefactor"
WHERE "createdAt" < ${cutoff}
```

#### commentCount
```sql
SELECT 'Bounty' as "entityType", t."bountyId" as "entityId", c."userId", 'Comment' as "metricType", 1 as "metricValue", c."createdAt"
FROM "Thread" t
JOIN "CommentV2" c ON c."threadId" = t.id
WHERE t."bountyId" IS NOT NULL AND c."createdAt" < ${cutoff}
```

### 10. BountyEntryMetric

#### reaction metrics
```sql
SELECT 'BountyEntry' as "entityType", "bountyEntryId" as "entityId", "userId",
       concat('Reaction', reaction) as "metricType", 1 as "metricValue", "createdAt"
FROM "BountyEntryReaction"
WHERE "createdAt" < ${cutoff} AND reaction IN ('Like', 'Dislike', 'Laugh', 'Cry', 'Heart')
```

#### unitAmountCount
```sql
SELECT 'BountyEntry' as "entityType", be."id" as "entityId", bb."userId", 'UnitAmount' as "metricType", bb."unitAmount" as "metricValue", bb."updatedAt"
FROM "BountyEntry" be
JOIN "BountyBenefactor" bb ON bb."awardedToId" = be."userId" AND bb."bountyId" = be."bountyId"
WHERE bb."updatedAt" < ${cutoff}
```

#### tippedCount / tippedAmountCount
```sql
SELECT 'BountyEntry' as "entityType", "entityId", "fromUserId" as "userId", 'TipCount' as "metricType", 1 as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'BountyEntry' AND "createdAt" < ${cutoff}

SELECT 'BountyEntry' as "entityType", "entityId", "fromUserId" as "userId", 'TipAmount' as "metricType", amount as "metricValue", "createdAt"
FROM "BuzzTip"
WHERE "entityType" = 'BountyEntry' AND "createdAt" < ${cutoff}
```

## Migration Processing Approach

### Higher-Order Migration Function

```typescript
type MetricQuery = {
  entityType: EntityMetric_EntityType_Type;
  metricType: EntityMetric_MetricType_Type;
  sql: Prisma.Sql;
};

async function migrateEntityMetrics(
  entityType: EntityMetric_EntityType_Type,
  idColumn: string,
  queries: MetricQuery[],
  params: MigrationParams
) {
  const cutoff = '2024-08-07 15:44:39.044'; // Or pass as parameter

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      // Get max ID for the entity type
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("${Prisma.raw(idColumn)}") "max" FROM "${Prisma.raw(entityType)}";`
      );
      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      let data: QueryRes[] = [];

      // Execute all queries for this entity type
      for (const query of queries) {
        const queryResult = await pgDbRead.cancellableQuery<QueryRes>(
          // Inject the range parameters into the query
          Prisma.sql`${query.sql} AND "${Prisma.raw(idColumn)}" BETWEEN ${start} AND ${end}`
        );
        cancelFns.push(queryResult.cancel);
        data = data.concat(await queryResult.result());
      }

      // Insert into ClickHouse
      await insertClickhouse(data, start, end);

      console.log(`Fetched ${entityType} metrics:`, start, '-', end);

      // Clean up cancel functions
      queries.forEach(q => remove(cancelFns, q.cancel));
    },
  });
}
```

### Usage Example

```typescript
// Migrate User metrics
await migrateEntityMetrics(
  'User',
  'id',
  [
    {
      entityType: 'User',
      metricType: 'Follower',
      sql: Prisma.sql`
        SELECT 'User' as "entityType", "targetUserId" as "entityId",
               "userId", 'Follower' as "metricType", 1 as "metricValue", "createdAt"
        FROM "UserEngagement"
        WHERE type = 'Follow' AND "createdAt" < ${cutoff}
      `
    },
    {
      entityType: 'User',
      metricType: 'Hidden',
      sql: Prisma.sql`
        SELECT 'User' as "entityType", "targetUserId" as "entityId",
               "userId", 'Hidden' as "metricType", 1 as "metricValue", "createdAt"
        FROM "UserEngagement"
        WHERE type = 'Hide' AND "createdAt" < ${cutoff}
      `
    },
    // ... more queries
  ],
  { concurrency: 10, batchSize: 500, start: 0 }
);
```

### ClickHouse-to-ClickHouse Migrations

Some metrics come from ClickHouse tables and need special handling:

1. **Model/ModelVersion downloadCount**: From `modelVersionEvents` where type = 'Download'
2. **Model/ModelVersion generationCount**: From `orchestration.jobs`
3. **Model/ModelVersion earnedAmount**: From `buzz_resource_compensation`

These will need a separate migration approach that reads from ClickHouse and writes back to the `entityMetricEvents` table.

### Migration Order

1. **User metrics** - Independent
2. **Collection metrics** - Independent
3. **Tag metrics** - Independent
4. **Model/ModelVersion metrics** - Do together, share some queries
5. **Post metrics** - Depends on Image
6. **Article metrics** - Independent
7. **Bounty/BountyEntry metrics** - Do together, share some queries
8. **ClickHouse metrics** - Last, after all Postgres data is migrated

@ai: I've outlined all the queries needed for each entityType/metricType combination based on the debezium.md mappings. The migration approach follows the pattern from migrate-img-metrics.ts but with a higher-order function that can handle any entity type systematically. The key improvements are:

1. Grouped related queries by entity type for efficiency
2. Created a reusable function that handles the range-based processing
3. Identified which metrics come from ClickHouse vs Postgres
4. Suggested an optimal migration order based on dependencies
