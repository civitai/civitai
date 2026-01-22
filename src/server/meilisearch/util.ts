import type { IndexOptions, MeiliSearchErrorInfo, Task, MeiliSearch } from 'meilisearch';
import { MeiliSearchTimeOutError } from 'meilisearch';
import { searchClient } from '~/server/meilisearch/client';
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
 * Remove all user content from search indexes
 * This function iterates through all available search indexes and removes documents
 * associated with the specified userId, if the index has userId as a filterable attribute.
 */
export const removeUserContentFromSearchIndex = async (userId: number) => {
  if (!searchClient) {
    return;
  }

  // Get all available indexes from constants
  const allIndexes = [
    IMAGES_SEARCH_INDEX,
    MODELS_SEARCH_INDEX,
    ARTICLES_SEARCH_INDEX,
    COLLECTIONS_SEARCH_INDEX,
    BOUNTIES_SEARCH_INDEX,
    USERS_SEARCH_INDEX,
  ];

  // Process all indexes in parallel
  const indexResults = await Promise.all(
    allIndexes.map(async (indexName) => {
      try {
        const index = await getOrCreateIndex(indexName, undefined, searchClient);

        if (!index) {
          return { indexName, status: 'skipped' as const, deleted: 0 };
        }

        // Get filterable attributes for this index
        const settings = await index.getSettings();
        const filterableAttributes = settings.filterableAttributes || [];

        // Determine which filter to use based on available attributes
        let filter: string | undefined;
        if (filterableAttributes.includes('user.id')) {
          filter = `user.id = ${userId}`;
        } else if (filterableAttributes.includes('userId')) {
          filter = `userId = ${userId}`;
        } else if (filterableAttributes.includes('id') && indexName === USERS_SEARCH_INDEX) {
          // For users index, filter by id directly
          filter = `id = ${userId}`;
        } else {
          // Skip indexes that don't have a userId-related filterable attribute
          console.log(
            `removeUserContentFromSearchIndex :: Skipping ${indexName} - no userId filterable attribute`
          );
          return { indexName, status: 'skipped' as const, deleted: 0 };
        }

        // Search for documents matching the userId
        const data = await index.search('', {
          filter,
          limit: 10000, // Increase limit to handle users with many documents
        });

        if (data.hits.length === 0) {
          console.log(`removeUserContentFromSearchIndex :: No documents found in ${indexName}`);
          return { indexName, status: 'processed' as const, deleted: 0 };
        }

        const documentIds = data.hits.map((hit) => (hit as Record<string, unknown>).id) as number[];

        console.log(
          `removeUserContentFromSearchIndex :: Deleting ${documentIds.length} documents from ${indexName}`
        );

        // Log to Axiom for tracking user content deletions
        await logToAxiom({
          name: 'remove-user-search-index-content',
          type: 'info',
          userId,
          indexName,
          documentCount: documentIds.length,
        }).catch();

        await index.deleteDocuments(documentIds);
        return { indexName, status: 'processed' as const, deleted: documentIds.length };
      } catch (error) {
        console.error(`removeUserContentFromSearchIndex :: Error processing ${indexName}:`, error);
        return { indexName, status: 'skipped' as const, deleted: 0 };
      }
    })
  );

  // Aggregate results
  const results = {
    processed: indexResults.filter((r) => r.status === 'processed').map((r) => r.indexName),
    skipped: indexResults.filter((r) => r.status === 'skipped').map((r) => r.indexName),
    deleted: indexResults.reduce((sum, r) => sum + r.deleted, 0),
  };

  console.log(
    `removeUserContentFromSearchIndex :: Complete - Processed: ${results.processed.join(
      ', '
    )}, Skipped: ${results.skipped.join(', ')}, Total deleted: ${results.deleted}`
  );

  // Log summary to Axiom
  await logToAxiom({
    name: 'remove-user-search-index-content-summary',
    type: 'info',
    userId,
    processedIndexes: results.processed,
    skippedIndexes: results.skipped,
    totalDeleted: results.deleted,
  }).catch();

  return results;
};

export { swapIndex, getOrCreateIndex, onSearchIndexDocumentsCleanup, waitForTasksWithRetries };
