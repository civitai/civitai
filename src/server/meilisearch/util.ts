import { IndexOptions, MeiliSearchErrorInfo } from 'meilisearch';
import { client } from '~/server/meilisearch/client';
import { PrismaClient, SearchIndexUpdateQueueAction } from '@prisma/client';

const getOrCreateIndex = async (indexName: string, options?: IndexOptions) => {
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
  const swapTask = await client.swapIndexes([{ indexes: [indexName, swapIndexName] }]);
  await client.waitForTask(swapTask.taskUid);
  console.log('swapOrCreateIndex :: complete swapIndexes, starting index delete...');
  await client.deleteIndex(swapIndexName);

  return index;
};

const onSearchIndexDocumentsCleanup = async ({
  db,
  indexName,
}: {
  db: PrismaClient;
  indexName: string;
}) => {
  if (!client) {
    return;
  }

  const queuedItemsToDelete = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: { type: indexName, action: SearchIndexUpdateQueueAction.Delete },
  });

  const itemIds = queuedItemsToDelete.map((queuedItem) => queuedItem.id);

  if (itemIds.length === 0) {
    return;
  }

  // Only care for main index ID here. Technically, if this was working as a reset and using a SWAP,
  // we wouldn't encounter delete items.
  const index = await getOrCreateIndex(indexName);

  if (!index) {
    // If for some reason we don't get an index, abort the entire process
    return;
  }

  const task = await index.deleteDocuments(itemIds);
  await client.waitForTask(task.taskUid);
};

export { swapIndex, getOrCreateIndex, onSearchIndexDocumentsCleanup };
