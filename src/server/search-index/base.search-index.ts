import { getJobDate, JobContext } from '~/server/jobs/job';
import { dbWrite, dbRead } from '~/server/db/client';
import { PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  swapIndex,
} from '~/server/meilisearch/util';
import { chunk } from 'lodash-es';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  getTaskQueueWorker,
  PullTask,
  PushTask,
  Task,
  TaskQueue,
  TransformTask,
} from '~/server/search-index/utils/taskQueue';
import { createLogger } from '~/utils/logging';

const DEFAULT_UPDATE_INTERVAL = 60 * 1000;
const logger = createLogger(`search-index-processor`);

type SearchIndexContext = {
  db: PrismaClient;
  indexName: string;
  jobContext: JobContext;
  logger: ReturnType<typeof createLogger>;
};
type SearchIndexPullBatch =
  | { type: 'new'; startId: number; endId: number }
  | { type: 'update'; ids: number[] };
type SearchIndexSetup = (context: { indexName: string }) => Promise<void>;

type SearchIndexProcessor = {
  indexName: string;
  setup: SearchIndexSetup;
  prepareBatches: (
    context: SearchIndexContext,
    lastUpdatedAt?: Date
  ) => Promise<{
    batchSize: number;
    startId: number;
    endId: number;
    updateIds?: number[];
  }>;
  pullData: (
    context: SearchIndexContext,
    batch: SearchIndexPullBatch,
    step?: number,
    prevData?: any
  ) => Promise<any>;
  transformData: (data: any) => Promise<any>;
  pushData: (context: SearchIndexContext, data: any) => Promise<void>;
  onComplete?: (context: SearchIndexContext) => Promise<void>;
  maxQueueSize?: number;
  primaryKey?: string;
  updateInterval?: number;
  workerCount?: number;
  pullSteps?: number;
};

const processSearchIndexTask = async (
  processor: SearchIndexProcessor,
  context: SearchIndexContext,
  task: Task
) => {
  const { type } = task;

  try {
    if (type === 'pull') {
      context.logger('processSearchIndexTask :: pull :: Processing task', task);
      const t = task as PullTask;
      const activeStep = t.currentStep ?? 0;
      const batch: SearchIndexPullBatch =
        t.mode === 'targeted'
          ? {
              type: 'update',
              ids: t.ids,
            }
          : {
              type: 'new',
              startId: t.startId,
              endId: t.endId,
            };
      const pulledData = await processor.pullData(context, batch, activeStep, t.currentData);

      if (!pulledData) {
        // We don't need to do anything if no data was pulled.
        context.logger('processSearchIndexTask :: pull :: No data pulled. Marking as done.');
        return 'done';
      }

      context.logger(
        `processSearchIndexTask :: pull :: Done. ${
          t.steps ? `Processing step ${activeStep + 1} of ${t.steps}` : ''
        }`
      );

      if (t?.steps && activeStep + 1 < t.steps) {
        return {
          ...t,
          currentData: pulledData,
          currentStep: activeStep + 1,
        } as PullTask;
      } else {
        return {
          type: 'transform',
          data: pulledData,
        } as TransformTask;
      }
    } else if (type === 'transform') {
      context.logger('processSearchIndexTask :: transform :: Processing task');
      const { data } = task as TransformTask;
      const transformedData = processor.transformData ? await processor.transformData(data) : data;
      context.logger('processSearchIndexTask :: transform :: Done');
      return {
        type: 'push',
        data: transformedData,
      } as PushTask;
    } else if (type === 'push') {
      context.logger('processSearchIndexTask :: Push :: Processing task');
      const { data } = task as PushTask;
      await processor.pushData(context, data);
      context.logger('processSearchIndexTask :: Push :: Done');
      return 'done';
    } else if (type === 'onComplete') {
      await processor.onComplete?.(context);
      return 'done';
    }
    return 'error';
  } catch (e) {
    console.error('processSearchIndexTask :: Error', e);
    return 'error';
  }
};

export type SearchIndexTaskResult = Awaited<ReturnType<typeof processSearchIndexTask>>;

export function createSearchIndexUpdateProcessor(processor: SearchIndexProcessor) {
  const {
    indexName,
    setup,
    prepareBatches,
    updateInterval = DEFAULT_UPDATE_INTERVAL,
    primaryKey = 'id',
    maxQueueSize,
    workerCount = 10,
  } = processor;

  return {
    indexName,
    async update(jobContext: JobContext) {
      const [lastUpdatedAt, setLastUpdate] = await getJobDate(
        `searchIndex:${indexName.toLowerCase()}`
      );
      const ctx = { db: dbRead, lastUpdatedAt, indexName, jobContext, logger };
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
      const queue = new TaskQueue('pull', maxQueueSize);
      const { batchSize, startId = 0, endId, updateIds } = await prepareBatches(ctx, lastUpdatedAt);
      logger(`createSearchIndexUpdateProcessor :: update :: Index last update at ${lastUpdatedAt}`, {batchSize, startId, endId, updateIds});

      const queuedUpdates = await SearchIndexUpdate.getQueue(
        indexName,
        SearchIndexUpdateQueueAction.Update
      );
      const queuedDeletes = await SearchIndexUpdate.getQueue(
        indexName,
        SearchIndexUpdateQueueAction.Delete
      );

      const newItemsTasks = Math.ceil((endId - startId) / batchSize);

      for (let i = 0; i < newItemsTasks; i++) {
        const start = startId + i * batchSize;
        const batch = {
          startId: start,
          endId: Math.min(start + batchSize - 1, endId),
        };

        queue.addTask({
          type: 'pull',
          mode: 'range',
          steps: processor.pullSteps,
          currentStep: 0,
          ...batch,
        });
      }

      const updatedItems = [...new Set<number>([...(updateIds ?? []), ...queuedUpdates.content])];

      const updateItemsTasks = Math.ceil(updatedItems.length / batchSize);

      for (let i = 0; i < updateItemsTasks; i++) {
        const batch = {
          ids: updatedItems.slice(i * batchSize, (i + 1) * batchSize),
        };

        queue.addTask({
          type: 'pull',
          mode: 'targeted',
          steps: processor.pullSteps,
          currentStep: 0,
          ...batch,
        });
      }

      const workers = Array.from({ length: workerCount }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) => processSearchIndexTask(processor, ctx, task),
          logger
        );
      });

      await Promise.all(workers);

      if (queuedDeletes.content.length > 0) {
        await onSearchIndexDocumentsCleanup({ indexName, ids: queuedDeletes.content });
      }

      // Commit queues:
      await queuedUpdates.commit();
      await queuedDeletes.commit();

      // await onIndexUpdate(ctx);
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
      const swapIndexName = `${indexName}_NEW`;
      await setup({ indexName: swapIndexName });

      const ctx = { db: dbRead, indexName: swapIndexName, jobContext, logger };
      // Run update
      const queue = new TaskQueue('pull', maxQueueSize);
      const { batchSize, startId = 0, endId } = await prepareBatches(ctx);

      const tasks = Math.ceil((endId - startId) / batchSize);
      for (let i = 0; i < tasks; i++) {
        const start = startId + i * batchSize;
        const batch = {
          startId: start,
          endId: Math.min(start + batchSize - 1, endId),
        };

        queue.addTask({
          type: 'pull',
          mode: 'range',
          steps: processor.pullSteps,
          currentStep: 0,
          ...batch,
        });
      }

      const workers = Array.from({ length: workerCount }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) => processSearchIndexTask(processor, ctx, task),
          logger
        );
      });

      await Promise.all(workers);
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
      const queue = new TaskQueue('pull', maxQueueSize);
      const batches = chunk(items, 500);

      for (const batch of batches) {
        const updateIds = batch
          .filter((i) => !i.action || i.action === SearchIndexUpdateQueueAction.Update)
          .map(({ id }) => id);
        const deleteIds = batch
          .filter((i) => i.action === SearchIndexUpdateQueueAction.Delete)
          .map(({ id }) => id);

        if (deleteIds.length > 0) {
          await onSearchIndexDocumentsCleanup({ indexName, ids: deleteIds });
        }

        if (updateIds.length > 0) {
          queue.addTask({
            type: 'pull',
            mode: 'targeted',
            ids: updateIds,
          });
        }
      }
      const workers = Array.from({ length: 5 }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) =>
            processSearchIndexTask(processor, { db: dbWrite, indexName, jobContext, logger }, task),
          logger
        );
      });

      await Promise.all(workers);
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
