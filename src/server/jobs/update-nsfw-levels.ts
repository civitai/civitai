import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from './job';
import { isDefined } from '~/utils/type-guards';
import { EntityType, ImageConnectionType } from '~/server/common/enums';
import { ModelStatus, Prisma } from '@prisma/client';
import {
  updateArticleNsfwLevels,
  updateBountyEntryNsfwLevels,
  updateBountyNsfwLevels,
  updateCollectionsNsfwLevels,
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
  updatePostNsfwLevels,
} from '~/server/services/nsfwLevels.service';

const imageNsfwLevelUpdateJob = createJob('update-nsfw-levels', '*/1 * * * *', async (e) => {
  // const [lastRun, setLastRun] = await getJobDate('update-nsfw-levels');
  const now = new Date();
  // TODO.nsfwLevel - work with more entity types to support tracking changes to other entities
  const updateQueue = await dbRead.nsfwLevelUpdateQueue.findMany({
    where: { createdAt: { lt: now } },
  });

  let postIds = updateQueue.filter((x) => x.entityType === EntityType.Post).map((x) => x.entityId);
  let articleIds = updateQueue
    .filter((x) => x.entityType === EntityType.Article)
    .map((x) => x.entityId);
  let bountyIds = updateQueue
    .filter((x) => x.entityType === EntityType.Bounty)
    .map((x) => x.entityId);
  let bountyEntryIds = updateQueue
    .filter((x) => x.entityType === EntityType.BountyEntry)
    .map((x) => x.entityId);
  let collectionIds = updateQueue
    .filter((x) => x.entityType === EntityType.Collection)
    .map((x) => x.entityId);
  let modelIds = updateQueue
    .filter((x) => x.entityType === EntityType.Model)
    .map((x) => x.entityId);
  let modelVersionIds = updateQueue
    .filter((x) => x.entityType === EntityType.ModelVersion)
    .map((x) => x.entityId);

  const imageIds = updateQueue
    .filter((x) => x.entityType === EntityType.Image)
    .map((x) => x.entityId);

  if (imageIds.length) {
    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds } },
      select: {
        postId: true,
        connections: true,
        article: { select: { id: true } },
      },
    });

    postIds = postIds.concat(images.map((x) => x.postId).filter(isDefined));
    articleIds = articleIds.concat(images.map((x) => x.article?.id).filter(isDefined));
    bountyIds = bountyIds.concat(
      images.flatMap((i) =>
        i.connections
          .filter((x) => x.entityType === ImageConnectionType.Bounty)
          .map((x) => x.entityId)
          .filter(isDefined)
      )
    );
    bountyEntryIds = bountyEntryIds.concat(
      images.flatMap((i) =>
        i.connections
          .filter((x) => x.entityType === ImageConnectionType.BountyEntry)
          .map((x) => x.entityId)
          .filter(isDefined)
      )
    );
  }

  if (postIds.length) {
    const modelVersions = await dbRead.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT DISTINCT ON(mv.id) mv.id
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId" AND p."publishedAt" IS NOT NULL
      WHERE mv.status = ${ModelStatus.Published}::"ModelStatus" AND p.id = ANY(ARRAY[${Prisma.join(
      postIds
    )}]::Int[])
      GROUP BY mv.id
    `);
    modelVersionIds = modelVersionIds.concat(modelVersions.map((x) => x.id));
  }

  if (modelVersionIds.length) {
    const models = await dbRead.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT DISTINCT ON (m.id) m.id
      FROM "Model" m
      JOIN "ModelVersion" mv on mv."modelId" = m.id
      WHERE mv.id = ANY(ARRAY[${Prisma.join(modelVersionIds)}]::Int[])
      GROUP BY m.id
    `);
    modelIds = modelIds.concat(models.map((x) => x.id));
  }

  const collectionItems = await Promise.all([
    modelIds.length
      ? await dbRead.collectionItem.findMany({
          where: { modelId: { in: modelIds } },
          select: { collectionId: true },
        })
      : undefined,
    articleIds.length
      ? await dbRead.collectionItem.findMany({
          where: { articleId: { in: articleIds } },
          select: { collectionId: true },
        })
      : undefined,
    imageIds.length
      ? await dbRead.collectionItem.findMany({
          where: { imageId: { in: imageIds } },
          select: { collectionId: true },
        })
      : undefined,
    postIds.length
      ? await dbRead.collectionItem.findMany({
          where: { postId: { in: postIds } },
          select: { collectionId: true },
        })
      : undefined,
  ]);

  collectionIds = collectionIds.concat(
    collectionItems
      .filter(isDefined)
      .flatMap((x) => x)
      .map((x) => x.collectionId)
  );

  const updatePosts = batcher(postIds, updatePostNsfwLevels);
  const updateArticles = batcher(articleIds, updateArticleNsfwLevels);
  const updateBounties = batcher(bountyIds, updateBountyNsfwLevels);
  const updateBountyEntries = batcher(bountyEntryIds, updateBountyEntryNsfwLevels);
  const updateModelVersions = batcher(modelVersionIds, updateModelVersionNsfwLevels);
  const updateModels = batcher(modelIds, updateModelNsfwLevels);
  const updateCollections = batcher(collectionIds, updateCollectionsNsfwLevels);

  const nsfwLevelChangeBatches = [
    [updatePosts, updateArticles, updateBounties, updateBountyEntries],
    [updateModelVersions],
    [updateModels],
    [updateCollections],
  ];

  for (const batch of nsfwLevelChangeBatches) {
    await Promise.all(batch);
  }

  await dbWrite.nsfwLevelUpdateQueue.deleteMany({ where: { createdAt: { lt: now } } });

  console.log({
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    collectionIds,
    modelVersionIds,
    modelIds,
  });

  console.log('end');
});

export const nsfwLevelsUpdateJobs = [imageNsfwLevelUpdateJob];

const batchSize = 1000;
function batcher(ids: number[], fn: (ids: number[]) => Promise<void>) {
  return async () => {
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += batchSize) {
      await fn(ids.slice(i, batchSize));
    }
  };
}
