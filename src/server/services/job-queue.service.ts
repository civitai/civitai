import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { Prisma } from '@prisma/client';

export async function enqueueJobs(
  jobs: { entityId: number; entityType: EntityType; type: JobQueueType }[]
) {
  if (!jobs?.length) return;

  const batches = chunk(jobs, 500);
  for (const batch of batches) {
    await dbWrite.$executeRaw`
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      VALUES ${Prisma.join(
        batch.map(
          ({ entityId, entityType, type }) =>
            Prisma.sql`(${entityId}::integer, ${entityType}::"EntityType", ${type}::"JobQueueType")`
        )
      )}
      ON CONFLICT DO NOTHING;
    `;
  }
}
