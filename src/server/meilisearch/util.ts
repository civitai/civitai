import { IndexOptions, MeiliSearchErrorInfo } from 'meilisearch';
import { client } from '~/server/meilisearch/client';

const getOrCreateIndex = async (indexName: string, options: IndexOptions = {}) => {
  if (!client) {
    return null;
  }

  try {
    // Will swap if index is created.
    return await client.getIndex(indexName);
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

  // Will swap if index is created. Non-created indexes cannot be swaped.
  const index = await getOrCreateIndex(indexName);
  console.log('swapOrCreateIndex :: start swapIndexes');
  const swapTask = await client.swapIndexes([{ indexes: [indexName, swapIndexName] }]);
  await client.waitForTask(swapTask.taskUid);
  console.log('swapOrCreateIndex :: complete swapIndexes, starting index delete...');
  await client.deleteIndex(swapIndexName);

  return index;
};

export { swapIndex, getOrCreateIndex };
