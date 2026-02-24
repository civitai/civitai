import { createJob } from './job';
import { processUserContentRemovalQueue } from '~/server/meilisearch/util';

export const searchIndexUserCleanupJob = createJob(
  'search-index-user-cleanup',
  '*/5 * * * *',
  async () => {
    return await processUserContentRemovalQueue();
  },
  {
    lockExpiration: 5 * 60,
  }
);
