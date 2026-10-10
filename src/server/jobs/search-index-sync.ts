import * as searchIndex from '~/server/search-index';
import type { JobContext } from './job';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

const searchIndexSets = {
  models: searchIndex.modelsSearchIndex,
  users: searchIndex.usersSearchIndex,
  articles: searchIndex.articlesSearchIndex,
  images: searchIndex.imagesSearchIndex,
  collections: searchIndex.collectionsSearchIndex,
  bounties: searchIndex.bountiesSearchIndex,
  imageMetrics: searchIndex.imagesMetricsSearchIndex,
  imageMetricsUpdateMetrics: searchIndex.imagesMetricsSearchIndexUpdateMetrics,
  tools: searchIndex.toolsSearchIndex,
  comics: searchIndex.comicsSearchIndex,
};

type SearchIndexSetKey = keyof typeof searchIndexSets;

const cronTimeMap: Record<SearchIndexSetKey, string> = {
  models: '*/15 * * * *',
  // Hourly at :07. Username/profile search freshness budget is large
  // (typeahead tolerates an hour of staleness fine), and offsetting from
  // models's `*/15` (:00/:15/:30/:45) avoids both jobs firing on the same
  // minute and contending for the Meilisearch write lock.
  users: '7 * * * *',
  articles: '*/5 * * * *',
  // Retired — the `images_v6` search index is no longer served (see 868m4c2dn). The processor
  // is `retired`, so this job would no-op anyway; keeping it unrunnable stops the scheduler
  // from firing it at all.
  images: UNRUNNABLE_JOB_CRON,
  collections: '*/10 * * * *',
  bounties: '*/5 * * * *',
  imageMetrics: '*/1 * * * *',
  imageMetricsUpdateMetrics: '*/1 * * * *',
  tools: UNRUNNABLE_JOB_CRON,
  comics: '*/5 * * * *',
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
        /**
         * A reset is the textbook case `keepLockOnDisconnect` was added for: it legitimately runs
         * far longer than the scheduler's client timeout, and it is harmful to run twice
         * concurrently. Without this, losing the socket releases the lock and the scheduler's retry
         * starts a SECOND reset of the same index while the first is still writing — both into the
         * same `<indexName>_NEW`, so whichever swaps first promotes an interleaving of two runs,
         * and the later one's `swapIndex` then deletes an index the other may still be using.
         *
         * It narrows the window rather than closing it: a pod that DIES still drops its lock within
         * seconds. That is why `reset` refuses a swap index it finds populated instead of assuming
         * it owns one, and why that refusal does not delete it.
         */
        keepLockOnDisconnect: true,
      }
    ),
  ])
  .flat();

async function timedExecution<T>(fn: (jobContext: JobContext) => Promise<T>, e: JobContext) {
  const start = Date.now();
  await fn(e);
  return Date.now() - start;
}
