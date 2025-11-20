import type { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  MODELS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
} from '~/server/common/constants';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

/**
 * Search Index Registry
 *
 * This registry provides a centralized way for services to queue search index updates
 * without directly importing search index implementations, breaking circular dependencies.
 *
 * Instead of importing the indices directly, this uses the SearchIndexUpdate queue
 * which is the underlying mechanism that all search indices use anyway.
 */

type SearchIndexName =
  | 'models'
  | 'users'
  | 'articles'
  | 'images'
  | 'imagesMetrics'
  | 'collections'
  | 'bounties'
  | 'tools';

// Map of search index names to their constants
const indexNameMap: Record<SearchIndexName, string> = {
  models: MODELS_SEARCH_INDEX,
  users: USERS_SEARCH_INDEX,
  articles: ARTICLES_SEARCH_INDEX,
  images: IMAGES_SEARCH_INDEX,
  imagesMetrics: METRICS_IMAGES_SEARCH_INDEX,
  collections: COLLECTIONS_SEARCH_INDEX,
  bounties: BOUNTIES_SEARCH_INDEX,
  tools: TOOLS_SEARCH_INDEX,
};

/**
 * Queue an update for a specific search index
 * This function can be called from services without creating circular dependencies
 * It directly uses the SearchIndexUpdate queue instead of importing search index objects
 */
export async function queueSearchIndexUpdate(
  indexName: SearchIndexName,
  items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>
): Promise<void> {
  const indexKey = indexNameMap[indexName];
  if (!indexKey) {
    console.warn(`Search index '${indexName}' not found in registry`);
    return;
  }

  await SearchIndexUpdate.queueUpdate({ indexName: indexKey, items });
}

/**
 * Helper functions for queueing updates to specific indices
 * These provide a convenient API for services
 */

export const searchIndexRegistry = {
  models: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('models', items),
  },
  users: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('users', items),
  },
  articles: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('articles', items),
  },
  images: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('images', items),
  },
  imagesMetrics: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('imagesMetrics', items),
  },
  collections: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('collections', items),
  },
  bounties: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('bounties', items),
  },
  tools: {
    queueUpdate: (items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>) =>
      queueSearchIndexUpdate('tools', items),
  },
};
