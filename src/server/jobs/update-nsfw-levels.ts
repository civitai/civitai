import { uniq } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from './job';
import { isDefined } from '~/utils/type-guards';
import { EntityType, JobQueueType } from '@prisma/client';
import {
  getImageConnectedEntities,
  getPostConnectedEntities,
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
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.UpdateNsfwLevel },
  });

  const imageIds: number[] = [];
  let postIds: number[] = [];
  let articleIds: number[] = [];
  let bountyIds: number[] = [];
  let bountyEntryIds: number[] = [];
  let collectionIds: number[] = [];
  let modelIds: number[] = [];
  let modelVersionIds: number[] = [];

  for (const { entityType, entityId } of jobQueue) {
    if (entityType === EntityType.Image) imageIds.push(entityId);
    if (entityType === EntityType.Post) postIds.push(entityId);
    if (entityType === EntityType.Article) articleIds.push(entityId);
    if (entityType === EntityType.Bounty) bountyIds.push(entityId);
    if (entityType === EntityType.BountyEntry) bountyEntryIds.push(entityId);
    if (entityType === EntityType.Collection) collectionIds.push(entityId);
    if (entityType === EntityType.Model) modelIds.push(entityId);
    if (entityType === EntityType.ModelVersion) modelVersionIds.push(entityId);
  }

  if (imageIds.length) {
    const imageRelations = await getImageConnectedEntities(imageIds);
    postIds = uniq(postIds.concat(imageRelations.postIds));
    articleIds = uniq(articleIds.concat(imageRelations.articleIds));
    bountyIds = uniq(bountyIds.concat(imageRelations.bountyIds));
    bountyEntryIds = uniq(bountyEntryIds.concat(imageRelations.bountyEntryIds));
  }

  if (postIds.length) {
    const postRelations = await getPostConnectedEntities(postIds);
    modelVersionIds = uniq(modelVersionIds.concat(postRelations.modelVersionIds));
    collectionIds = uniq(collectionIds.concat(postRelations.collectionIds));
  }

  if (modelVersionIds.length) {
    const modelVersions = await dbRead.modelVersion.findMany({
      where: { id: { in: modelVersionIds } },
      select: { modelId: true },
    });
    modelIds = modelIds.concat(modelVersions.map((x) => x.modelId).filter(isDefined));
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

  await dbWrite.jobQueue.deleteMany({
    where: { createdAt: { lt: now }, type: JobQueueType.UpdateNsfwLevel },
  });

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
function batcher<TResult>(ids: number[], fn: (ids: number[]) => Promise<unknown>) {
  return async () => {
    let arr: TResult[] = [];
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += batchSize) {
      const result = await fn(ids.slice(i, batchSize));
      if (result) arr = arr.concat(result as TResult[]);
    }
  };
}
