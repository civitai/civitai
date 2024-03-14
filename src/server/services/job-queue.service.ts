import { EntityType, JobQueueType } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { chunk } from 'lodash-es';

export async function enqueueJobs(
  jobs: { entityId: number; entityType: EntityType; type: JobQueueType }[]
) {
  if (!jobs?.length) return;

  const batches = chunk(jobs, 500);
  for (const batch of batches) {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      VALUES ${batch
        .map(
          ({ entityId, entityType, type }) =>
            `(${entityId}, ${entityType}::"EntityType", ${type}::"JobQueueType")`
        )
        .join(', ')}
      ON CONFLICT DO NOTHING;
    `);
  }
}

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
