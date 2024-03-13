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

export function reduceJobQueueToIds(jobs: { entityId: number; entityType: EntityType }[]) {
  return jobs.reduce<{
    imageIds: number[];
    postIds: number[];
    articleIds: number[];
    bountyIds: number[];
    bountyEntryIds: number[];
    collectionIds: number[];
    modelIds: number[];
    modelVersionIds: number[];
  }>(
    (acc, { entityType, entityId }) => {
      if (entityType === EntityType.Image) acc.imageIds.push(entityId);
      if (entityType === EntityType.Post) acc.postIds.push(entityId);
      if (entityType === EntityType.Article) acc.articleIds.push(entityId);
      if (entityType === EntityType.Bounty) acc.bountyIds.push(entityId);
      if (entityType === EntityType.BountyEntry) acc.bountyEntryIds.push(entityId);
      if (entityType === EntityType.Collection) acc.collectionIds.push(entityId);
      if (entityType === EntityType.Model) acc.modelIds.push(entityId);
      if (entityType === EntityType.ModelVersion) acc.modelVersionIds.push(entityId);
      return acc;
    },
    {
      imageIds: [],
      postIds: [],
      articleIds: [],
      bountyIds: [],
      bountyEntryIds: [],
      collectionIds: [],
      modelIds: [],
      modelVersionIds: [],
    }
  );
}
