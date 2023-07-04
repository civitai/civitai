import { createJob } from './job';
import * as searchIndex from '~/server/search-index';

const searchIndexSets = {
  models: searchIndex.modelsSearchIndex,
};

export const searchIndexJobs = Object.entries(searchIndexSets).map(([name, searchIndexProcessor]) =>
  createJob(
    `search-index-sync-${name}`,
    '*/1 * * * *',
    async () => {
      const searchIndexSyncTime = await timedExecution(searchIndexProcessor.update);

      return {
        [name]: searchIndexSyncTime,
      };
    },
    {
      lockExpiration: 30 * 60,
    }
  )
);

async function timedExecution<T>(fn: () => Promise<T>) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}
