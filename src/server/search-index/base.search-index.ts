import type { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { MeiliSearch } from 'meilisearch';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import type { JobContext } from '~/server/jobs/job';
import { getJobDate } from '~/server/jobs/job';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  swapIndex,
} from '~/server/meilisearch/util';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import type {
  PullTask,
  PushTask,
  Task,
  TransformTask,
} from '~/server/search-index/utils/taskQueue';
import { getTaskQueueWorker, TaskQueue } from '~/server/search-index/utils/taskQueue';
import { createLogger } from '~/utils/logging';

const DEFAULT_UPDATE_INTERVAL = 30 * 1000;
const logger = createLogger(`search-index-processor`);

type SearchIndexContext = {
  db: PrismaClient;
  pg: AugmentedPool;
  ch?: CustomClickHouseClient;
  indexName: string;
  jobContext?: JobContext;
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
  client?: MeiliSearch | null;
  jobName?: string;
  partial?: boolean;
  queues?: ('delete' | 'update')[];
};

const processSearchIndexTask = async (
  processor: SearchIndexProcessor,
  context: SearchIndexContext,
  task: Task
) => {
  const { type } = task;
  let logDetails: any = '';
  if (task.index !== undefined && task.total) logDetails = `${task.index + 1} of ${task.total}`;
  if (task.currentStep !== undefined) logDetails += ` - ${task.currentStep + 1} of ${task.steps}`;
  context.logger(
    `processSearchIndexTask :: ${type} :: ${processor.indexName} :: Processing task`,
    logDetails
  );

  try {
    if (type === 'pull') {
      context.logger(`processSearchIndexTask :: pull :: ${processor.indexName} :: Processing task`);
      const start = (task.start ??= Date.now());
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
        context.logger(
          `processSearchIndexTask :: pull :: ${processor.indexName} :: No data pulled. Marking as done.`,
          start ? (Date.now() - start) / 1000 : 'unknown duration'
        );
        return 'done';
      }

      if (t?.steps && activeStep + 1 < t.steps) {
        return {
          ...t,
          currentData: pulledData,
          currentStep: activeStep + 1,
          start,
        } as PullTask;
      } else {
        return {
          start,
          type: 'transform',
          index: task.index,
          total: task.total,
          data: pulledData,
        } as TransformTask;
      }
    } else if (type === 'transform') {
      context.logger(
        `processSearchIndexTask :: transform :: ${processor.indexName} :: Processing task`
      );
      const { data, start } = task as TransformTask;
      const transformedData = processor.transformData ? await processor.transformData(data) : data;
      return {
        start,
        type: 'push',
        index: task.index,
        total: task.total,
        data: transformedData,
      } as PushTask;
    } else if (type === 'push') {
      context.logger(`processSearchIndexTask :: Push :: ${processor.indexName} :: Processing task`);
      const { data, start } = task as PushTask;
      await processor.pushData(context, data);
      context.logger(
        `processSearchIndexTask :: Push :: ${processor.indexName} :: Done`,
        start ? (Date.now() - start) / 1000 : 'unknown duration'
      );

      return 'done';
    } else if (type === 'onComplete') {
      await processor.onComplete?.(context);
      return 'done';
    }
    return 'error';
  } catch (e) {
    console.error(`processSearchIndexTask :: ${type} :: ${processor.indexName} :: Error`, e);
    return 'error';
  } finally {
    context.logger(
      `processSearchIndexTask :: ${type} :: ${processor.indexName} :: Done`,
      logDetails
    );
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
    jobName,
    partial,
    queues,
  } = processor;

  return {
    indexName,
    async getData(ids: number[]) {
      const ctx = {
        db: dbWrite,
        pg: pgDbWrite,
        ch: clickhouse,
        indexName,
        logger,
      };

      const baseData = await processor.pullData(ctx, {
        type: 'update',
        ids,
      });

      return processor.transformData ? await processor.transformData(baseData) : baseData;
    },
    async update(jobContext: JobContext) {
      const [lastUpdatedAt, setLastUpdate] = await getJobDate(
        `searchIndex:${(jobName ?? indexName).toLowerCase()}`
      );
      const ctx = {
        db: dbWrite,
        pg: pgDbWrite,
        ch: clickhouse,
        lastUpdatedAt,
        indexName,
        jobContext,
        logger,
      };
      // Check if update is needed
      const shouldUpdate = lastUpdatedAt.getTime() + updateInterval < Date.now();

      if (!shouldUpdate) {
        console.log(
          `createSearchIndexUpdateProcessor :: update :: ${indexName} :: Job does not require updating yet.`
        );
        return;
      }

      // Run update
      const now = new Date();
      const queue = new TaskQueue('pull', maxQueueSize);
      logger(
        `createSearchIndexUpdateProcessor :: update :: ${indexName} :: About to prepare batches...`
      );
      const { batchSize, startId = 0, endId, updateIds } = await prepareBatches(ctx, lastUpdatedAt);
      logger(
        `createSearchIndexUpdateProcessor :: update :: ${indexName} :: Index last update at ${lastUpdatedAt}`,
        { batchSize, startId, endId, updateIds }
      );

      const queuedUpdates =
        !queues || queues.includes('update')
          ? await SearchIndexUpdate.getQueue(
              indexName,
              SearchIndexUpdateQueueAction.Update,
              partial ? true : false // readOnly
            )
          : {
              content: [],
              commit: async () => undefined, // noop
            };
      const queuedDeletes =
        !queues || queues.includes('delete')
          ? await SearchIndexUpdate.getQueue(
              indexName,
              SearchIndexUpdateQueueAction.Delete,
              partial ? true : false // readOnly
            )
          : {
              content: [],
              commit: async () => undefined, // noop
            };

      const newItemsTasks = Math.ceil((endId - startId) / batchSize);

      // if (true) {
      //   console.log({
      //     startid: startId,
      //     endid: endId,
      //     update: queuedUpdates.content.length,
      //     delete: queuedDeletes.content.length,
      //     total: endId - startId,
      //   });

      //   return;
      // }

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
          index: i,
          total: newItemsTasks,
          ...batch,
        });
      }

      const updatedItems = [...new Set<number>([...(updateIds ?? []), ...queuedUpdates.content])];

      const maxUpdateBatchSize = Math.min(batchSize, 10000); // To avoid too large batches for postgres
      const updateItemsTasks = Math.ceil(updatedItems.length / maxUpdateBatchSize);

      for (let i = 0; i < updateItemsTasks; i++) {
        const batch = {
          ids: updatedItems.slice(i * maxUpdateBatchSize, (i + 1) * maxUpdateBatchSize),
        };

        queue.addTask({
          type: 'pull',
          mode: 'targeted',
          steps: processor.pullSteps,
          currentStep: 0,
          index: i,
          total: updateItemsTasks,
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

      if (queuedDeletes.content.length > 0 && !partial) {
        await onSearchIndexDocumentsCleanup({
          indexName,
          ids: queuedDeletes.content,
          client: processor.client,
        });
      }

      // Commit queues:
      await queuedUpdates.commit();
      await queuedDeletes.commit();

      // Use the start time as the time of update
      // Should  help avoid missed items during the run
      // of the index.
      if (!partial || jobName) {
        // Partial indexes should not update the last update time
        await setLastUpdate(now);
      }
    },
    /**
     * Resets an entire index by using its swap counterpart.
     * The goal here is to ensure we keep the  existing search index during the
     * reset process.
     */
    async reset(jobContext: JobContext) {
      // First, setup and init both indexes - Swap requires both indexes to be created:
      // In order to swap, the base index must exist. because of this, we need to create or get it.
      await getOrCreateIndex(indexName, { primaryKey }, processor.client);
      const swapIndexName = `${indexName}_NEW`;
      if (!partial) {
        await setup({ indexName: swapIndexName });
      }

      const ctx = {
        db: dbRead,
        pg: pgDbRead,
        indexName: partial ? indexName : swapIndexName,
        jobContext,
        logger,
      };
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
      if (!partial) {
        // Finally, perform the swap:
        await swapIndex({ indexName, swapIndexName, client: processor.client });
        // Clear update queue since our index should be brand new:
        await SearchIndexUpdate.clearQueue(indexName);
      }
    },
    async updateSync(
      items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>,
      jobContext?: JobContext
    ) {
      if (!items.length) {
        return;
      }

      // TODO index.update shouldnt run
      // await setup({ indexName });

      console.log(
        `createSearchIndexUpdateProcessor :: updateSync :: ${indexName} :: Called with ${items.length} items`
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

        if (deleteIds.length > 0 && !partial) {
          await onSearchIndexDocumentsCleanup({
            indexName,
            ids: deleteIds,
            client: processor.client,
          });
        }

        if (updateIds.length > 0) {
          queue.addTask({
            type: 'pull',
            mode: 'targeted',
            ids: updateIds,
            steps: processor.pullSteps,
            currentStep: 0,
          });
        }
      }

      const workers = Array.from({ length: 5 }).map(() => {
        return getTaskQueueWorker(
          queue,
          async (task) =>
            processSearchIndexTask(
              processor,
              { db: dbWrite, pg: pgDbWrite, indexName, jobContext, logger },
              task
            ),
          logger
        );
      });

      await Promise.all(workers);
    },
    async queueUpdate(items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) {
      await SearchIndexUpdate.queueUpdate({ indexName, items });
    },
    async processQueues(
      opts: { processUpdates?: boolean; processDeletes?: boolean } = {},
      jobContext: JobContext
    ) {
      const ctx = {
        db: dbRead,
        pg: pgDbRead,
        indexName,
        jobContext,
        logger,
      };

      if (opts.processUpdates) {
        const queuedUpdates = await SearchIndexUpdate.getQueue(
          indexName,
          SearchIndexUpdateQueueAction.Update,
          partial ? true : false // readOnly
        );

        const updatedItems = [...new Set<number>([...queuedUpdates.content])];

        const queue = new TaskQueue('pull', maxQueueSize);
        const maxUpdateBatchSize = 10000; // To avoid too large batches for postgres
        const updateItemsTasks = Math.ceil(updatedItems.length / maxUpdateBatchSize);

        for (let i = 0; i < updateItemsTasks; i++) {
          const batch = {
            ids: updatedItems.slice(i * maxUpdateBatchSize, (i + 1) * maxUpdateBatchSize),
          };

          queue.addTask({
            type: 'pull',
            mode: 'targeted',
            steps: processor.pullSteps,
            currentStep: 0,
            index: i,
            total: updateItemsTasks,
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
        await queuedUpdates.commit();
      }

      if (opts.processDeletes) {
        const queuedDeletes = await SearchIndexUpdate.getQueue(
          indexName,
          SearchIndexUpdateQueueAction.Delete,
          partial ? true : false // readOnly
        );

        if (queuedDeletes.content.length > 0 && !partial) {
          await onSearchIndexDocumentsCleanup({
            indexName,
            ids: queuedDeletes.content,
            client: processor.client,
          });
        }

        // Commit queues:
        await queuedDeletes.commit();
      }
    },
  };
}

export type SearchIndexSetupContext = {
  indexName: string;
};
