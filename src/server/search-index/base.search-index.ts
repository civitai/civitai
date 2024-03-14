import { getJobDate, JobContext } from '~/server/jobs/job';
import { dbWrite, dbRead } from '~/server/db/client';
import { PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { getOrCreateIndex, swapIndex } from '~/server/meilisearch/util';
import { chunk } from 'lodash-es';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

const DEFAULT_UPDATE_INTERVAL = 60 * 1000;

export function createSearchIndexUpdateProcessor({
  indexName,
  swapIndexName,
  onIndexUpdate,
  onIndexSetup,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
  primaryKey = 'id',
}: {
  indexName: string;
  swapIndexName: string;
  onIndexUpdate: SearchIndexProcessorContext;
  onIndexSetup: SearchIndexSetupProcessorContext;
  updateInterval?: number;
  primaryKey?: string;
}) {
  return {
    indexName,
    async update(jobContext: JobContext) {
      const [lastUpdatedAt, setLastUpdate] = await getJobDate(
        `searchIndex:${indexName.toLowerCase()}`
      );
      const ctx = { db: dbRead, lastUpdatedAt, indexName, jobContext };
      // Check if update is needed
      const shouldUpdate = lastUpdatedAt.getTime() + updateInterval < Date.now();

      if (!shouldUpdate) {
        console.log(
          'createSearchIndexUpdateProcessor :: update :: Job does not require updating yet.'
        );
        return;
      }

      // Run update
      const now = new Date();
      await onIndexUpdate(ctx);
      // Use the start time as the time of update
      // Should  help avoid missed items during the run
      // of the index.
      await setLastUpdate(now);
    },
    /**
     * Resets an entire index by using its swap counterpart.
     * The goal here is to ensure we keep the  existing search index during the
     * reset process.
     */
    async reset(jobContext: JobContext) {
      // First, setup and init both indexes - Swap requires both indexes to be created:
      // In order to swap, the base index must exist. because of this, we need to create or get it.
      await getOrCreateIndex(indexName, { primaryKey });
      await onIndexSetup({ indexName: swapIndexName });

      // Now, fill in the "swap" with new content:
      await onIndexUpdate({ db: dbWrite, indexName: swapIndexName, jobContext });

      // Finally, perform the swap:
      await swapIndex({ indexName, swapIndexName });

      // Clear update queue since our index should be brand new:
      await SearchIndexUpdate.clearQueue(indexName);
    },
    async updateSync(
      items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>,
      jobContext: JobContext
    ) {
      if (!items.length) {
        return;
      }

      console.log(
        `createSearchIndexUpdateProcessor :: ${indexName} :: updateSync :: Called with ${items.length} items`
      );

      const batches = chunk(items, 500);

      for (const batch of batches) {
        const updateIds = batch
          .filter((i) => !i.action || i.action === SearchIndexUpdateQueueAction.Update)
          .map(({ id }) => id);
        const deleteIds = batch
          .filter((i) => i.action === SearchIndexUpdateQueueAction.Delete)
          .map(({ id }) => id);

        await onIndexUpdate({ db: dbWrite, indexName, updateIds, deleteIds, jobContext });
      }
    },
    async queueUpdate(items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) {
      await SearchIndexUpdate.queueUpdate({ indexName, items });
    },
  };
}
export type SearchIndexRunContext = {
  db: PrismaClient;
  indexName: string;
  jobContext: JobContext;
  lastUpdatedAt?: Date;
  updateIds?: number[];
  deleteIds?: number[];
};

export type SearchIndexSetupContext = {
  indexName: string;
};

type SearchIndexProcessorContext = (context: SearchIndexRunContext) => Promise<void>;
type SearchIndexSetupProcessorContext = (context: SearchIndexSetupContext) => Promise<void>;
