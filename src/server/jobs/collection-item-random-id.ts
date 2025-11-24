import { updateCollectionRandomSeed } from '~/server/services/collection.service';
import { createJob } from './job';

export const updateCollectionItemRandomId = createJob(
  'update-collection-item-random-id',
  '0 * * * *',
  async () => {
    // Updates the random seed in Redis on an hourly basis.
    // This seed is used for hash-based random ordering of collection items.
    await updateCollectionRandomSeed();
  }
);
