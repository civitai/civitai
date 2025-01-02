import { Prisma } from '@prisma/client';
import { CollectionItemStatus, EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import dayjs from 'dayjs';
import { chunk, uniq } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import {
  getNsfwLevelRelatedEntities,
  updateNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

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
    where: { type: JobQueueType.UpdateNsfwLevel, entityType: { not: EntityType.Collection } },
  });

  const jobQueueIds = reduceJobQueueToIds(jobQueue);
  const relatedEntities = await getNsfwLevelRelatedEntities(jobQueueIds);

  await imagesSearchIndex.queueUpdate(
    jobQueueIds.imageIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );
  await imagesMetricsSearchIndex.queueUpdate(
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
  // const collectionIds = uniq([...jobQueueIds.collectionIds, ...relatedEntities.collectionIds]);

  await updateNsfwLevels({
    postIds,
    articleIds,
    bountyIds,
    bountyEntryIds,
    modelVersionIds,
    modelIds,
    collectionIds: [],
  });

  await dbWrite.jobQueue.deleteMany({
    where: {
      createdAt: { lt: now },
      type: JobQueueType.UpdateNsfwLevel,
      entityType: { not: EntityType.Collection },
    },
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

// A more lightweight job to update nsfw levels for collections which runs every five minutes
const updateCollectionNsfwLevelsJob = createJob(
  'update-collection-nsfw-levels',
  '*/5 * * * *',
  async () => {
    const now = new Date();
    const jobQueue = await dbRead.jobQueue.findMany({
      where: { type: JobQueueType.UpdateNsfwLevel, entityType: EntityType.Collection },
    });
    const collectionIds = jobQueue.map((x) => x.entityId);
    if (!collectionIds.length) return;

    await dbWrite.$executeRaw`
      UPDATE "Collection" c
      SET "nsfwLevel" = (
        SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel",0)), 0)
        FROM "CollectionItem" ci
        LEFT JOIN "Image" i on i.id = ci."imageId" AND c.type = 'Image'
        LEFT JOIN "Post" p on p.id = ci."postId" AND c.type = 'Post' AND p."publishedAt" IS NOT NULL
        LEFT JOIN "Model" m on m.id = ci."modelId" AND c.type = 'Model' AND m."status" = 'Published'
        LEFT JOIN "Article" a on a.id = ci."articleId" AND c.type = 'Article' AND a."publishedAt" IS NOT NULL
        WHERE ci."collectionId" = c.id AND ci.status = ${
          CollectionItemStatus.ACCEPTED
        }::"CollectionItemStatus"
      )
      WHERE c.id in (${Prisma.join(collectionIds)});
    `;

    await dbWrite.jobQueue.deleteMany({
      where: {
        createdAt: { lt: now },
        type: JobQueueType.UpdateNsfwLevel,
        entityType: EntityType.Collection,
      },
    });
  }
);

export const jobQueueJobs = [
  updateNsfwLevelJob,
  handleJobQueueCleanup,
  handleJobQueueCleanIfEmpty,
  updateCollectionNsfwLevelsJob,
];
