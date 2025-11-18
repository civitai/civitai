import { randomizeCollectionItems } from '~/server/services/collection.service';
import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const updateCollectionItemRandomId = createJob(
  'update-collection-item-random-id',
  '0 * * * *',
  async () => {
    // Updates the random order IDs of items on an hourly basis for contest collections.
    const contestCollectionIds = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT
      id,
      c."createdAt"
      FROM "Collection" c
      WHERE c.mode = 'Contest'
      AND (c."metadata"->'challengeDate') IS NULL
      AND (
        ((c."metadata"->'endsAt') IS NULL AND c."createdAt" > now() - interval '2 weeks')
        OR DATE(c."metadata"->>'endsAt') > NOW()::DATE
      );
    `;

    const tasks = contestCollectionIds.map(({ id }) => async () => {
      await randomizeCollectionItems(id);
    });

    await limitConcurrency(tasks, 3);
  }
);
