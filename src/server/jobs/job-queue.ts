import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from './job';
import { JobQueueType, SearchIndexUpdateQueueAction } from '@prisma/client';
import {
  getNsfwLevelRelatedEntities,
  updateNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { reduceJobQueueToIds } from '~/server/services/job-queue.service';
import { uniq, chunk } from 'lodash-es';
import { imagesSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const updateNsfwLevelJob = createJob('update-nsfw-levels', '*/1 * * * *', async (e) => {
  // const [lastRun, setLastRun] = await getJobDate('update-nsfw-levels');
  const now = new Date();
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.UpdateNsfwLevel },
  });

  const jobQueueIds = reduceJobQueueToIds(jobQueue);
  const relatedEntities = await getNsfwLevelRelatedEntities(jobQueueIds);

  await imagesSearchIndex.queueUpdate(
    jobQueueIds.imageIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );

  const postIds = uniq([...jobQueueIds.postIds, ...relatedEntities.postIds]);
  const articleIds = uniq([...jobQueueIds.articleIds, ...relatedEntities.articleIds]);
  const bountyIds = uniq([...jobQueueIds.bountyIds, ...relatedEntities.bountyIds]);
  const bountyEntryIds = uniq([...jobQueueIds.bountyEntryIds, ...relatedEntities.bountyEntryIds]);
  const modelVersionIds = uniq([
    ...jobQueueIds.modelVersionIds,
    ...relatedEntities.modelVersionIds,
  ]);
  const modelIds = uniq([...jobQueueIds.modelIds, ...relatedEntities.modelIds]);
  const collectionIds = uniq([...jobQueueIds.collectionIds, ...relatedEntities.collectionIds]);

  await updateNsfwLevels({
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    modelVersionIds,
    modelIds,
    collectionIds,
  });

  await dbWrite.jobQueue.deleteMany({
    where: { createdAt: { lt: now }, type: JobQueueType.UpdateNsfwLevel },
  });
});

const batchSize = 1000;
const handleJobQueueCleanup = createJob('job-queue-cleanup', '*/1 * * * *', async (e) => {
  const now = new Date();
  const jobQueue = await dbRead.jobQueue.findMany({
    where: { type: JobQueueType.CleanUp },
  });

  const jobQueueIds = reduceJobQueueToIds(jobQueue);
  const relatedEntities = await getNsfwLevelRelatedEntities(jobQueueIds);

  //handle cleanup
  const cleanupImages = () =>
    chunk(jobQueueIds.imageIds, batchSize).map((ids) => async () => {
      await dbWrite.imageConnection.deleteMany({ where: { imageId: { in: ids } } });
      await dbWrite.collectionItem.deleteMany({ where: { imageId: { in: ids } } });
    });
  const cleanupPosts = () =>
    chunk(jobQueueIds.postIds, batchSize).map((ids) => async () => {
      await dbWrite.collectionItem.deleteMany({ where: { postId: { in: ids } } });
    });
  const cleanupArticles = () =>
    chunk(jobQueueIds.articleIds, batchSize).map((ids) => async () => {
      await dbWrite.collectionItem.deleteMany({ where: { articleId: { in: ids } } });
    });
  const cleanupModels = () =>
    chunk(jobQueueIds.modelIds, batchSize).map((ids) => async () => {
      await dbWrite.collectionItem.deleteMany({ where: { modelId: { in: ids } } });
    });

  const tasks = [cleanupImages(), cleanupPosts(), cleanupArticles(), cleanupModels()].flat();
  await limitConcurrency(tasks, 5);

  await updateNsfwLevels(relatedEntities);

  await dbWrite.jobQueue.deleteMany({
    where: { createdAt: { lt: now }, type: JobQueueType.CleanUp },
  });
});

export const jobQueueJobs = [updateNsfwLevelJob, handleJobQueueCleanup];
