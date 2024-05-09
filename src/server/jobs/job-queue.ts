import { dbRead, dbWrite } from '~/server/db/client';
import { createJob } from './job';
import { EntityType, JobQueueType, Prisma } from '@prisma/client';
import {
  getNsfwLevelRelatedEntities,
  updateNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { uniq, chunk } from 'lodash-es';
import { imagesSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import dayjs from 'dayjs';

const jobQueueMap = {
  [EntityType.Image]: 'imageIds',
  [EntityType.Post]: 'postIds',
  [EntityType.Article]: 'articleIds',
  [EntityType.Bounty]: 'bountyIds',
  [EntityType.BountyEntry]: 'bountyEntryIds',
  [EntityType.Collection]: 'collectionIds',
  [EntityType.Model]: 'modelIds',
  [EntityType.ModelVersion]: 'modelVersionIds',
} as const;
type JobQueueMap = typeof jobQueueMap;
type JobQueueIds = {
  [K in JobQueueMap[keyof JobQueueMap]]: number[];
};

export function reduceJobQueueToIds(jobs: { entityId: number; entityType: EntityType }[]) {
  const jobIds: Partial<JobQueueIds> = {};
  for (const key in jobQueueMap) {
    jobIds[jobQueueMap[key as keyof JobQueueMap]] = [];
  }
  for (const job of jobs) {
    const key = jobQueueMap[job.entityType];
    if (!jobIds[key]) jobIds[key] = [];
    jobIds[key]!.push(job.entityId);
  }
  return jobIds as JobQueueIds;
}

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

const handleJobQueueCleanIfEmpty = createJob(
  'job-queue-clean-if-empty',
  '0 */1 * * *',
  async () => {
    const cutoff = dayjs().subtract(1, 'day').toDate();
    const jobQueue = await dbRead.jobQueue.findMany({
      where: { type: JobQueueType.CleanIfEmpty, createdAt: { lt: cutoff } },
    });

    const jobQueueIds = reduceJobQueueToIds(jobQueue);

    //handle cleanup
    const cleanupPosts = () =>
      chunk(jobQueueIds.postIds, batchSize).map((ids) => async () => {
        if (!ids.length) return;
        // Delete posts that have no images
        await dbWrite.$executeRaw`
          DELETE FROM "Post" p
          WHERE id IN (${Prisma.join(ids)}) AND NOT EXISTS (
            SELECT 1 FROM "Image" WHERE "postId" = p.id
          )
        `;
      });

    const tasks = [cleanupPosts()].flat();
    await limitConcurrency(tasks, 5);

    await dbWrite.jobQueue.deleteMany({
      where: { type: JobQueueType.CleanIfEmpty, createdAt: { lt: cutoff } },
    });
  }
);

export const jobQueueJobs = [updateNsfwLevelJob, handleJobQueueCleanup, handleJobQueueCleanIfEmpty];
