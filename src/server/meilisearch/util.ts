import type { IndexOptions, MeiliSearchErrorInfo, Task, MeiliSearch } from 'meilisearch';
import { MeiliSearchTimeOutError } from 'meilisearch';
import { searchClient, metricsSearchClient } from '~/server/meilisearch/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { withRetries } from '~/server/utils/errorHandling';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
} from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';

const WAIT_FOR_TASKS_MAX_RETRIES = 5;

const getOrCreateIndex = async (
  indexName: string,
  options?: IndexOptions,
  client: MeiliSearch | null = searchClient
) => {
  return withRetries(
    async () => {
      if (!client) {
        return null;
      }

      try {
        console.log('getOrCreateIndex :: Getting index :: ', indexName);
        // Will swap if index is created.
        // console.log(client);
        const index = await client.getIndex(indexName);

        if (options) {
          await index.update(options);
        }

        return index;
      } catch (e) {
        const meiliSearchError = e as MeiliSearchErrorInfo;

        if (meiliSearchError.code === 'index_not_found') {
          console.error('getOrCreateIndex :: Error :: Index not found. Attempting to create it...');
          const createdIndexTask = await client.createIndex(indexName, options);
          await client.waitForTask(createdIndexTask.taskUid);
          return await client.getIndex(indexName);
        } else {
          console.error('getOrCreateIndex :: Error :: ', e);
        }

        // Don't handle it within this scope
        throw e;
      }
    },
    3,
    60000 // 60 seconds - This can take a while to create an index
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
  client = searchClient,
}: {
  indexName: string;
  swapIndexName: string;
  client?: MeiliSearch | null;
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
  indexName,
  ids,
  client = searchClient,
}: {
  indexName: string;
  ids?: number[];
  client?: MeiliSearch | null;
}) => {
  if (!client) {
    return;
  }

  if (ids) {
    console.log(`onSearchIndexDocumentsCleanup :: About to delete: ${ids.length} items...`);

    const index = await getOrCreateIndex(indexName, undefined, client);

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
  const index = await getOrCreateIndex(indexName, undefined, client);

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
  remainingRetries: number = WAIT_FOR_TASKS_MAX_RETRIES,
  client: MeiliSearch | null = searchClient
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

/**
 * Remove all user content from search indexes using filter-based deletion.
 * This function processes all search indexes (main and metrics) and removes documents
 * associated with the specified user using Meilisearch's deleteDocuments with filter.
 * No document count limit - filter-based deletion handles any number of documents.
 */
export const removeUserContentFromSearchIndex = async ({
  userId,
  username,
}: {
  userId: number;
  username: string;
}) => {
  // Escape username for Meilisearch filter (escape quotes and backslashes)
  const escapedUsername = username.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Define index configurations with their filter strategies
  // Some indexes have user.id filterable, others only have user.username
  const mainIndexConfigs = [
    { name: MODELS_SEARCH_INDEX, filter: `user.id = ${userId}` },
    { name: IMAGES_SEARCH_INDEX, filter: `user.username = "${escapedUsername}"` },
    { name: ARTICLES_SEARCH_INDEX, filter: `user.username = "${escapedUsername}"` },
    { name: COLLECTIONS_SEARCH_INDEX, filter: `user.username = "${escapedUsername}"` },
    { name: BOUNTIES_SEARCH_INDEX, filter: `user.username = "${escapedUsername}"` },
    { name: USERS_SEARCH_INDEX, filter: `id = ${userId}` },
  ];

  const metricsIndexConfigs = [
    { name: METRICS_IMAGES_SEARCH_INDEX, filter: `userId = ${userId}` },
  ];

  const processIndex = async (
    indexName: string,
    filter: string,
    client: MeiliSearch | null
  ): Promise<{ indexName: string; status: 'processed' | 'skipped' }> => {
    if (!client) {
      return { indexName, status: 'skipped' };
    }

    try {
      const index = await getOrCreateIndex(indexName, undefined, client);
      if (!index) {
        return { indexName, status: 'skipped' };
      }

      console.log(`removeUserContentFromSearchIndex :: Deleting from ${indexName} with filter: ${filter}`);

      // Use filter-based deletion - no limit on document count
      await index.deleteDocuments({ filter });

      // Log to Axiom for tracking
      await logToAxiom({
        name: 'remove-user-search-index-content',
        type: 'info',
        userId,
        username,
        indexName,
        filter,
      }).catch();

      return { indexName, status: 'processed' };
    } catch (error) {
      console.error(`removeUserContentFromSearchIndex :: Error processing ${indexName}:`, error);
      await logToAxiom({
        name: 'remove-user-search-index-content-error',
        type: 'error',
        userId,
        username,
        indexName,
        error: error instanceof Error ? error.message : String(error),
      }).catch();
      return { indexName, status: 'skipped' };
    }
  };

  // Process all indexes in parallel using allSettled for resilience
  // If one index fails, others should still complete
  const results = await Promise.allSettled([
    // Main search indexes
    ...mainIndexConfigs.map(({ name, filter }) => processIndex(name, filter, searchClient)),
    // Metrics search indexes (separate Meilisearch instance)
    ...metricsIndexConfigs.map(({ name, filter }) => processIndex(name, filter, metricsSearchClient)),
  ]);

  const processed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 'processed') {
        processed.push(result.value.indexName);
      } else {
        skipped.push(result.value.indexName);
      }
    } else {
      // Promise rejected - should be rare since processIndex catches errors
      failed.push('unknown');
    }
  }

  console.log(
    `removeUserContentFromSearchIndex :: Complete - Processed: ${processed.join(', ')}, Skipped: ${skipped.join(', ')}`
  );

  // Log summary to Axiom
  await logToAxiom({
    name: 'remove-user-search-index-content-summary',
    type: 'info',
    userId,
    username,
    processedIndexes: processed,
    skippedIndexes: skipped,
  }).catch();

  return { processed, skipped };
};

export { swapIndex, getOrCreateIndex, onSearchIndexDocumentsCleanup, waitForTasksWithRetries };
