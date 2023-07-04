import { MeiliSearchErrorInfo } from 'meilisearch';
import { client } from '~/server/meilisearch/client';

/**
 * Swaps an index with another. If the base index is not created, will create one so that it can be swapped.
 *
 * @param {String} indexName The main index name
 * @param {String} swapIndexName The swap index name.
 * @returns {Promise<void>}
 */
const swapIndex = async (indexName: string, swapIndexName: string) => {
  if (!client) {
    return;
  }

  const onSwap = async () => {
    if (!client) {
      return;
    }

    console.log('swapOrCreateIndex :: start swapIndexes');
    const swapTask = await client.swapIndexes([{ indexes: [indexName, swapIndexName] }]);
    await client.waitForTask(swapTask.taskUid);
    console.log('swapOrCreateIndex :: complete swapIndexes, starting index delete...');
    await client.deleteIndex('models_new');
  };

  try {
    // Will swap if index is created.
    await client.getIndex('models');
    await onSwap();
  } catch (e) {
    const meiliSearchError = e as MeiliSearchErrorInfo;

    if (meiliSearchError.code === 'index_not_found') {
      // Will create the index, then swap:
      await client.createIndex('models', { primaryKey: 'id' });
      await onSwap();
    }
  }
};

export { swapIndex };
