import { createJob, JobContext, UNRUNNABLE_JOB_CRON } from './job';
import * as searchIndex from '~/server/search-index';

const searchIndexSets = {
  models: searchIndex.modelsSearchIndex,
  users: searchIndex.usersSearchIndex,
  articles: searchIndex.articlesSearchIndex,
  images: searchIndex.imagesSearchIndex,
  collections: searchIndex.collectionsSearchIndex,
  bounties: searchIndex.bountiesSearchIndex,
};

type SearchIndexSetKey = keyof typeof searchIndexSets;

const cronTimeMap: Record<SearchIndexSetKey, string> = {
  models: '*/5 * * * *',
  users: '*/10 * * * *',
  articles: '*/5 * * * *',
  images: '*/20 * * * *',
  collections: '*/10 * * * *',
  bounties: '*/5 * * * *',
};

export const searchIndexJobs = Object.entries(searchIndexSets)
  .map(([name, searchIndexProcessor]) => [
    createJob(
      `search-index-sync-${name}`,
      cronTimeMap[name as SearchIndexSetKey],
      async (e) => {
        const searchIndexSyncTime = await timedExecution(searchIndexProcessor.update, e);

        return {
          [name]: searchIndexSyncTime,
        };
      },
      {
        lockExpiration: 10 * 60,
      }
    ),
    createJob(
      `search-index-sync-${name}-reset`,
      UNRUNNABLE_JOB_CRON,
      async (e) => {
        const searchIndexSyncTime = await timedExecution(searchIndexProcessor.reset, e);
        return {
          [`${name}-reset`]: searchIndexSyncTime,
        };
      },
      {
        // 3hr lock. This can be a long-running job.
        lockExpiration: 180 * 60,
      }
    ),
  ])
  .flat();

async function timedExecution<T>(fn: (jobContext: JobContext) => Promise<T>, e: JobContext) {
  const start = Date.now();
  await fn(e);
  return Date.now() - start;
}
