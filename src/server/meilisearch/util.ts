import { IndexOptions, MeiliSearchErrorInfo, MeiliSearchTimeOutError, Task } from 'meilisearch';
import { client } from '~/server/meilisearch/client';
import { PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { withRetries } from '~/server/utils/errorHandling';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

const WAIT_FOR_TASKS_MAX_RETRIES = 5;

const getOrCreateIndex = async (indexName: string, options?: IndexOptions) => {
  return withRetries(
    async () => {
      if (!client) {
        return null;
      }

      try {
        // Will swap if index is created.
        const index = await client.getIndex(indexName);

        if (options) {
          await index.update(options);
        }

        return index;
      } catch (e) {
        const meiliSearchError = e as MeiliSearchErrorInfo;

        if (meiliSearchError.code === 'index_not_found') {
          const createdIndexTask = await client.createIndex(indexName, options);
          await client.waitForTask(createdIndexTask.taskUid);
          return await client.getIndex(indexName);
        }

        // Don't handle it within this scope
        throw e;
      }
    },
    3,
    1500
  );
};

/**
 * Swaps an index with another. If the base index is not created, will create one so that it can be swapped.
 *
 * @param {String} indexName The main index name
 * @param {String} swapIndexName The swap index name.
 * @returns {Promise<void>}
 */
const swapIndex = async ({
  indexName,
  swapIndexName,
}: {
  indexName: string;
  swapIndexName: string;
}) => {
  if (!client) {
    return;
  }

  // Will swap if index is created. Non-created indexes cannot be swapped.
  const index = await getOrCreateIndex(indexName);
  console.log('swapOrCreateIndex :: start swapIndexes from', swapIndexName, 'to', indexName);
  await client.swapIndexes([{ indexes: [indexName, swapIndexName] }]);
  console.log('swapOrCreateIndex :: Swap task created');
  await client.deleteIndex(swapIndexName);

  return index;
};

const onSearchIndexDocumentsCleanup = async ({
  db,
  indexName,
  ids,
}: {
  db: PrismaClient;
  indexName: string;
  ids?: number[];
}) => {
  if (!client) {
    return;
  }

  if (ids) {
    console.log(`onSearchIndexDocumentsCleanup :: About to delete: ${ids.length} items...`);

    const index = await getOrCreateIndex(indexName);

    if (!index) {
      // If for some reason we don't get an index, abort the entire process
      return;
    }

    await index.deleteDocuments(ids);
    console.log('onSearchIndexDocumentsCleanup :: tasks for deletion has been added');

    return;
  }

  const queuedItemsToDelete = await SearchIndexUpdate.getQueue(
    indexName,
    SearchIndexUpdateQueueAction.Delete
  );
  const itemIds = queuedItemsToDelete.content;

  if (itemIds.length === 0) {
    return;
  }

  console.log(`onSearchIndexDocumentsCleanup :: About to delete: ${itemIds.length} items...`);

  // Only care for main index ID here. Technically, if this was working as a reset and using a SWAP,
  // we wouldn't encounter delete items.
  const index = await getOrCreateIndex(indexName);

  if (!index) {
    // If for some reason we don't get an index, abort the entire process
    return;
  }

  await index.deleteDocuments(itemIds);
  await queuedItemsToDelete.commit();
  console.log('onSearchIndexDocumentsCleanup :: tasks for deletion has been added');
};

const waitForTasksWithRetries = async (
  taskUids: number[],
  remainingRetries: number = WAIT_FOR_TASKS_MAX_RETRIES
): Promise<Task[]> => {
  if (!client) {
    return [];
  }

  if (remainingRetries === 0) {
    throw new MeiliSearchTimeOutError('');
  }

  try {
    // Attempt to increase a little the timeOutMs every time such that
    // if the issue is a long queue, we can account for it:
    const timeOutMs = 5000 * (1 + WAIT_FOR_TASKS_MAX_RETRIES - remainingRetries);
    const tasks = await client.waitForTasks(taskUids, { timeOutMs });

    return tasks;
  } catch (e) {
    if (e instanceof MeiliSearchTimeOutError) {
      return waitForTasksWithRetries(taskUids, remainingRetries - 1);
    }

    throw e;
  }
};

export { swapIndex, getOrCreateIndex, onSearchIndexDocumentsCleanup, waitForTasksWithRetries };
