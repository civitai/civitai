import { Prisma } from '@prisma/client';
import { chunk, uniq } from 'lodash-es';
import { ImageConnectionType, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  articlesSearchIndex,
  bountiesSearchIndex,
  collectionsSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

async function getImageConnectedEntities(imageIds: number[]) {
  // these dbReads could be run concurrently
  const [images, connections, articles /* , collectionItems */] = await Promise.all([
    dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: { postId: true },
    }),
    dbRead.imageConnection.findMany({
      where: { imageId: { in: imageIds } },
      select: { entityType: true, entityId: true },
    }),
    dbRead.article.findMany({
      where: { coverId: { in: imageIds } },
      select: { id: true },
    }),
    // dbRead.collectionItem.findMany({
    //   where: { imageId: { in: imageIds } },
    //   select: { collectionId: true },
    // }),
  ]);

  return {
    postIds: images.map((x) => x.postId).filter(isDefined),
    articleIds: articles.map((x) => x.id),
    bountyIds: connections
      .filter((x) => x.entityType === ImageConnectionType.Bounty)
      .map((x) => x.entityId),
    bountyEntryIds: connections
      .filter((x) => x.entityType === ImageConnectionType.BountyEntry)
      .map((x) => x.entityId),
    collectionIds: [], // collectionItems.map((x) => x.collectionId),
  };
}

async function getPostConnectedEntities(postIds: number[]) {
  const [posts /* collectionItems */] = await Promise.all([
    dbRead.post.findMany({
      where: { id: { in: postIds } },
      select: { modelVersionId: true },
    }),
    // dbRead.collectionItem.findMany({
    //   where: { postId: { in: postIds } },
    //   select: { collectionId: true },
    // }),
  ]);

  return {
    modelVersionIds: posts.map((x) => x.modelVersionId).filter(isDefined),
    collectionIds: [], // collectionItems.map((x) => x.collectionId),
  };
}

async function getModelVersionConnectedEntities(modelVersionIds: number[]) {
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: { modelId: true },
  });

  return {
    modelIds: modelVersions.map((x) => x.modelId),
  };
}

async function getModelConnectedEntities(modelIds: number[]) {
  // const collectionItems = await dbRead.collectionItem.findMany({
  //   where: { modelId: { in: modelIds } },
  //   select: { collectionId: true },
  // });

  return {
    collectionIds: [], // collectionItems.map((x) => x.collectionId),
  };
}

async function getArticleConnectedEntities(articleIds: number[]) {
  // const collectionItems = await dbRead.collectionItem.findMany({
  //   where: { articleId: { in: articleIds } },
  //   select: { collectionId: true },
  // });

  return {
    collectionIds: [], // collectionItems.map((x) => x.collectionId),
  };
}

export async function getNsfwLevelRelatedEntities(source: {
  imageIds?: number[];
  postIds?: number[];
  articleIds?: number[];
  bountyIds?: number[];
  bountyEntryIds?: number[];
  collectionIds?: number[];
  modelIds?: number[];
  modelVersionIds?: number[];
}) {
  let postIds: number[] = [];
  let articleIds: number[] = [];
  let bountyIds: number[] = [];
  let bountyEntryIds: number[] = [];
  const collectionIds: number[] = [];
  let modelIds: number[] = [];
  let modelVersionIds: number[] = [];

  function mergeRelated(
    data: Partial<{
      postIds: number[];
      articleIds: number[];
      bountyIds: number[];
      bountyEntryIds: number[];
      collectionIds: number[];
      modelIds: number[];
      modelVersionIds: number[];
    }>
  ) {
    if (data.postIds) postIds = uniq(postIds.concat(data.postIds));
    if (data.articleIds) articleIds = uniq(articleIds.concat(data.articleIds));
    if (data.bountyIds) bountyIds = uniq(bountyIds.concat(data.bountyIds));
    if (data.bountyEntryIds) bountyEntryIds = uniq(bountyEntryIds.concat(data.bountyEntryIds));
    // if (data.collectionIds) collectionIds = uniq(collectionIds.concat(data.collectionIds));
    if (data.modelIds) modelIds = uniq(modelIds.concat(data.modelIds));
    if (data.modelVersionIds) modelVersionIds = uniq(modelVersionIds.concat(data.modelVersionIds));
  }

  if (source.imageIds?.length) {
    const imageRelations = await getImageConnectedEntities(source.imageIds);
    mergeRelated(imageRelations);
  }

  if (source.postIds?.length || postIds.length) {
    const postRelations = await getPostConnectedEntities([...(source.postIds ?? []), ...postIds]);
    mergeRelated(postRelations);
  }

  if (source.articleIds?.length || articleIds.length) {
    const articleRelations = await getArticleConnectedEntities([
      ...(source.articleIds ?? []),
      ...articleIds,
    ]);
    mergeRelated(articleRelations);
  }

  if (source.modelVersionIds?.length || modelVersionIds.length) {
    const modelVersionRelations = await getModelVersionConnectedEntities([
      ...(source.modelVersionIds ?? []),
      ...modelVersionIds,
    ]);
    mergeRelated(modelVersionRelations);
  }

  if (source.modelIds?.length || modelIds.length) {
    const modelRelations = await getModelConnectedEntities([
      ...(source.modelIds ?? []),
      ...modelIds,
    ]);
    mergeRelated(modelRelations);
  }

  return {
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    collectionIds,
    modelIds,
    modelVersionIds,
  };
}

const batchSize = 1000;
function batcher(ids: number[], fn: (ids: number[]) => Promise<void>) {
  return chunk(ids, batchSize).map((chunk) => async () => {
    try {
      if (chunk.length > 0) {
        // console.log('processing chunk', chunk.length, fn.name);
        await fn(chunk);
      }
    } catch (e) {
      console.log('processing chunk', chunk.length, fn.name);
    }
  });
}

export async function updateNsfwLevels({
  postIds,
  articleIds,
  bountyIds,
  bountyEntryIds,
  collectionIds,
  modelIds,
  modelVersionIds,
}: {
  postIds: number[];
  articleIds: number[];
  bountyIds: number[];
  bountyEntryIds: number[];
  collectionIds: number[];
  modelIds: number[];
  modelVersionIds: number[];
}) {
  const updatePosts = batcher(postIds, updatePostNsfwLevels);
  const updateArticles = batcher(articleIds, updateArticleNsfwLevels);
  const updateBounties = batcher(bountyIds, updateBountyNsfwLevels);
  const updateBountyEntries = batcher(bountyEntryIds, updateBountyEntryNsfwLevels);
  const updateModelVersions = batcher(modelVersionIds, updateModelVersionNsfwLevels);
  const updateModels = batcher(modelIds, updateModelNsfwLevels);
  // const updateCollections = batcher(collectionIds, updateCollectionsNsfwLevels);

  const nsfwLevelChangeBatches = [
    [updatePosts, updateArticles, updateBounties, updateBountyEntries],
    [updateModelVersions],
    [updateModels],
    // [updateCollections],
  ];

  for (const batch of nsfwLevelChangeBatches) {
    const tasks = batch.flat();
    await limitConcurrency(tasks, 5);
  }
}

export async function updatePostNsfwLevels(postIds: number[]) {
  if (!postIds.length) return;
  await dbWrite.$queryRaw(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p.id IN (${Prisma.join(postIds)})
      GROUP BY p.id
    )
    UPDATE "Post" p
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = p.id AND level."nsfwLevel" != p."nsfwLevel";
  `);
}

export async function updateArticleNsfwLevels(articleIds: number[]) {
  if (!articleIds.length) return;
  const articles = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
      WITH level AS (
        SELECT DISTINCT ON (a.id) a.id, bit_or(i."nsfwLevel") "nsfwLevel"
        FROM "Article" a
        JOIN "Image" i ON a."coverId" = i.id
        WHERE a.id IN (${Prisma.join(articleIds)})
        GROUP BY a.id
      )
      UPDATE "Article" a
      SET "nsfwLevel" = (
        CASE
          WHEN a."userNsfwLevel" > a."nsfwLevel" THEN a."userNsfwLevel"
          ELSE level."nsfwLevel"
        END
      )
      FROM level
      WHERE level.id = a.id AND level."nsfwLevel" != a."nsfwLevel"
      RETURNING a.id;
    `);
  await articlesSearchIndex.queueUpdate(
    articles.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateBountyNsfwLevels(bountyIds: number[]) {
  if (!bountyIds.length) return;
  const bounties = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
      WITH level AS (
        SELECT DISTINCT ON ("entityId")
          "entityId",
          bit_or(i."nsfwLevel") "nsfwLevel"
        FROM "ImageConnection" ic
        JOIN "Image" i ON i.id = ic."imageId"
        JOIN "Bounty" b on b.id = ic."entityId" AND ic."entityType" = 'Bounty'
        WHERE ic."entityType" = 'Bounty' AND ic."entityId" IN (${Prisma.join(bountyIds)})
        GROUP BY 1
      )
      UPDATE "Bounty" b SET "nsfwLevel" = (
        CASE
          WHEN b.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
          ELSE level."nsfwLevel"
        END
      )
      FROM level
      WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
      RETURNING b.id;
    `);
  await bountiesSearchIndex.queueUpdate(
    bounties.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateBountyEntryNsfwLevels(bountyEntryIds: number[]) {
  if (!bountyEntryIds.length) return;
  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT DISTINCT ON ("entityId")
        "entityId",
        bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "ImageConnection" ic
      JOIN "Image" i ON i.id = ic."imageId"
      JOIN "BountyEntry" b on b.id = "entityId" AND ic."entityType" = 'BountyEntry'
      WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" IN (${Prisma.join(bountyEntryIds)})
      GROUP BY 1
    )
    UPDATE "BountyEntry" b SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel"
    RETURNING b.id;
  `);
}

export async function updateCollectionsNsfwLevels(collectionIds: number[]) {
  if (!collectionIds.length) return;
  const collections = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH collection_items AS (
      SELECT * FROM "CollectionItem" WHERE status = ${
        CollectionItemStatus.ACCEPTED
      }::"CollectionItemStatus" AND "collectionId" in (${Prisma.join(collectionIds)})
    ),
    collection_levels AS (
      SELECT
        c.id,
        c.type,
        c."nsfwLevel",
        (
          CASE
            WHEN c.nsfw is true
            THEN ${nsfwBrowsingLevelsFlag}
            WHEN c.type = 'Image'
            THEN (
              SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", 0)), 0)
                FROM collection_items ci
              JOIN "Image" i ON ci."imageId" = i.id
              WHERE ci."collectionId" = c.id
            )
            WHEN c.type = 'Post'
            THEN (
              SELECT COALESCE(bit_or(COALESCE(p."nsfwLevel", 0)), 0)
                FROM collection_items ci
              JOIN "Post" p ON ci."postId" = p.id
              WHERE ci."collectionId" = c.id
              AND p."publishedAt" IS NOT NULL
            )
            WHEN c.type = 'Article'
            THEN (
              SELECT COALESCE(bit_or(COALESCE(a."nsfwLevel", 0)), 0)
                FROM collection_items ci
              JOIN "Article" a ON ci."articleId" = a.id
              WHERE ci."collectionId" = c.id
              AND a."publishedAt" IS NOT NULL
            )
            WHEN c.type = 'Model'
            THEN (
              SELECT COALESCE(bit_or(COALESCE(m."nsfwLevel", 0)), 0)
                FROM collection_items ci
              JOIN "Model" m ON ci."modelId" = m.id
              WHERE ci."collectionId" = c.id
              AND m."status" = 'Published'
            )
          END
        ) AS "updatedNsfwLevel"
      FROM "Collection" c WHERE id IN (90510, 1064011)
    ),
    collections AS (select id, "updatedNsfwLevel" from collection_levels WHERE "nsfwLevel" != "updatedNsfwLevel")
    UPDATE "Collection" c SET
      "nsfwLevel" = c2."updatedNsfwLevel"
    FROM (SELECT * FROM collections) AS c2
    WHERE c2.id = c.id
    RETURNING c.id, c."nsfwLevel";
  `);
  await collectionsSearchIndex.queueUpdate(
    collections.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateModelNsfwLevels(modelIds: number[]) {
  if (!modelIds.length) return;
  const models = await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level AS (
      SELECT
        mv."modelId" as "id",
        bit_or(mv."nsfwLevel") "nsfwLevel"
      FROM "ModelVersion" mv
      WHERE mv."modelId" IN (${Prisma.join(modelIds)})
      AND mv.status = 'Published'
      GROUP BY mv."modelId"
    )
    UPDATE "Model" m
    SET "nsfwLevel" = (
      CASE
        WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
        ELSE level."nsfwLevel"
      END
    )
    FROM level
    WHERE level.id = m.id AND (level."nsfwLevel" != m."nsfwLevel" OR m.nsfw = TRUE)
    RETURNING m.id;
  `);
  await modelsSearchIndex.queueUpdate(
    models.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

export async function updateModelVersionNsfwLevels(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return;
  const updateSystemNsfwLevel =
    (await sysRedis.hGet(
      REDIS_SYS_KEYS.SYSTEM.FEATURES,
      'update-system-model-version-nsfw-level'
    )) !== 'false';

  await dbWrite.$queryRaw<{ id: number }[]>(Prisma.sql`
    WITH level as (
      SELECT
        mv.id,
        CASE
          WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
          -- WHEN m."userId" = -1 THEN (
          --   SELECT COALESCE(bit_or(ranked."nsfwLevel"), 0) "nsfwLevel"
          --   FROM (
          --     SELECT
          --     ir."imageId" id,
          --     i."nsfwLevel"
          --     FROM "ImageResource" ir
          --     JOIN "Image" i ON i.id = ir."imageId"
          --     JOIN "Post" p ON p.id = i."postId"
          --     JOIN "ImageMetric" im ON im."imageId" = ir."imageId" AND im.timeframe = 'AllTime'::"MetricTimeframe"
          --     WHERE ir."modelVersionId" = mv.id
          --     AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0 AND i."nsfwLevel" != 32
          --     ORDER BY im."reactionCount" DESC
          --     LIMIT 20
          --   ) AS ranked
          -- )
          WHEN m."userId" != -1 THEN (
            SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
            FROM (
              SELECT
                i."nsfwLevel"
              FROM "Post" p
              JOIN "Image" i ON i."postId" = p.id
              WHERE p."modelVersionId" = mv.id
              AND p."userId" = m."userId"
              AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0 AND i."nsfwLevel" != 32
              ORDER BY p."id", i."index"
              LIMIT 20
            ) AS i
          )
        END AS "nsfwLevel"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mv.id IN (${Prisma.join(modelVersionIds)})
      ${updateSystemNsfwLevel ? Prisma.sql`` : Prisma.raw('AND m."userId" > 0')}
    )
    UPDATE "ModelVersion" mv
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel"
    RETURNING mv.id;
  `);
}
