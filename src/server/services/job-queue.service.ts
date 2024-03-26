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
