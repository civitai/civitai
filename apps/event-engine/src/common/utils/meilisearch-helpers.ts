import { IMeilisearch, IMeilisearchIndex } from '../types/meilisearch-interface';

/**
 * Get or create a Meilisearch index
 *
 * @param client - Meilisearch client
 * @param indexName - Name of the index
 * @param options - Index options (e.g., primaryKey)
 * @returns The index instance
 */
export async function getOrCreateIndex(
  client: IMeilisearch,
  indexName: string,
  options?: { primaryKey: string }
): Promise<IMeilisearchIndex> {
  try {
    const index = await client.getIndex(indexName);
    if (options) {
      await index.update(options);
    }
    return index;
  } catch (e: any) {
    if (e.code === 'index_not_found') {
      const task = await client.createIndex(indexName, options);
      await client.tasks.waitForTask(task.taskUid);
      return await client.getIndex(indexName);
    }
    throw e;
  }
}

/**
 * Helper to get or create a Meilisearch feed index with standard configuration
 *
 * @param config - Configuration with client and index name
 * @returns The index instance
 */
export async function getMeilisearchFeed(config: {
  client: IMeilisearch;
  name: string;
}): Promise<IMeilisearchIndex> {
  const { client, name } = config;
  return getOrCreateIndex(client, name, { primaryKey: 'id' });
}
