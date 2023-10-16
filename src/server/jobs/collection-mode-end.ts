import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const updateCollectionItemRandomId = createJob(
  'collection-mode-end',
  '0 * * * *',
  async () => {
    // Removes contest mode from collections that have ended.
    // Disable further entries
    await dbWrite.$executeRaw`
      UPDATE "Collection" SET mode = NULL, write = 'Private'
      WHERE mode = 'Contest' AND (metadata->>'endsAt')::timestamp < now();
    `;
  }
);
