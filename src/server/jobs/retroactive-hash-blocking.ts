import { unpublishBlockedModel } from '~/pages/api/webhooks/scan-result';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

export const retroactiveHashBlocking = createJob(
  'retroactive-hash-blocking',
  '3 2 * * *',
  async () => {
    const toBlock = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT
        mf."modelVersionId" as id
      FROM "BlockedModelHashes" b
      JOIN "ModelFileHash" mfh ON b.hash = mfh.hash AND mfh.type = 'SHA256'
      JOIN "ModelFile" mf ON mfh."fileId" = mf.id
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv.id
      WHERE mv.status = 'Published';
    `;

    const tasks = toBlock.map(({ id }) => async () => {
      await unpublishBlockedModel(id);
    });
    await limitConcurrency(tasks, 5);
  }
);
