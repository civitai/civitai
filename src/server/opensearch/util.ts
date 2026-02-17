import { openSearchClient } from './client';

/**
 * Create an index if it doesn't already exist, or update its mappings.
 */
export async function ensureIndex(
  indexName: string,
  mappings: Record<string, unknown>,
  settings?: Record<string, unknown>
): Promise<void> {
  if (!openSearchClient) return;

  const { body: exists } = await openSearchClient.indices.exists({ index: indexName });

  if (!exists) {
    console.log('ensureIndex :: Creating index ::', indexName);
    await openSearchClient.indices.create({
      index: indexName,
      body: {
        settings: settings ?? {},
        mappings,
      },
    });
    console.log('ensureIndex :: Index created ::', indexName);
  } else {
    // Update mappings on existing index
    console.log('ensureIndex :: Updating mappings for ::', indexName);
    await openSearchClient.indices.putMapping({
      index: indexName,
      body: mappings,
    });
  }
}

/**
 * Swap an alias from one index to another (atomic switch).
 * Creates the alias if it doesn't exist.
 */
export async function swapIndex(
  aliasName: string,
  newIndexName: string
): Promise<void> {
  if (!openSearchClient) return;

  // Check if alias exists and get current targets
  const { body: aliasExists } = await openSearchClient.indices.existsAlias({
    name: aliasName,
  });

  const actions: Array<Record<string, { index: string; alias: string }>> = [];

  if (aliasExists) {
    // Get current alias targets
    const { body: aliasInfo } = await openSearchClient.indices.getAlias({
      name: aliasName,
    });

    // Remove alias from all current indices
    for (const index of Object.keys(aliasInfo)) {
      actions.push({ remove: { index, alias: aliasName } });
    }
  }

  // Add alias to new index
  actions.push({ add: { index: newIndexName, alias: aliasName } });

  await openSearchClient.indices.updateAliases({
    body: { actions },
  });

  console.log('swapIndex :: Swapped alias', aliasName, 'to', newIndexName);
}