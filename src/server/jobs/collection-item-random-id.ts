import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const updateCollectionItemRandomId = createJob(
  'update-collection-item-random-id',
  '0 * * * *',
  async () => {
    // Updates the random order IDs of items on an hourly basis for contest collections.
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem" ci SET "randomId" = FLOOR(RANDOM() * 1000000000)
      FROM "Collection" c
      WHERE c.id = ci."collectionId"
        AND c."mode" = 'Contest'
        AND ci."status" = 'ACCEPTED'
        AND (
          (c."metadata"->'endsAt') IS NULL OR DATE(c."metadata"->>'endsAt') >= NOW()::DATE
        )
    `;
  }
);
