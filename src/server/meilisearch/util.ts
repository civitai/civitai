import type { IndexOptions, MeiliSearchErrorInfo, Task, MeiliSearch } from 'meilisearch';
import { MeiliSearchTimeOutError } from 'meilisearch';
import { searchClient, metricsSearchClient } from '~/server/meilisearch/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { withRetries } from '~/server/utils/errorHandling';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
} from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';

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

/**
 * Discards a swap index that will not be promoted.
 *
 * `swapIndex` deletes the swap index as its last step, so a reset that completes in a swap does not
 * need this. It exists for the reset that ABANDONS its rebuild: without it the half-built
 * `<indexName>_NEW` stays resident, holding a near-complete copy of the corpus until some later run
 * happens to swap.
 *
 * 🔴 BEST-EFFORT, AND NOT A CORRECTNESS MECHANISM. The deletion is a Meilisearch TASK and this
 * resolves when that task is ENQUEUED, not when it completes (`Index.delete` returns an
 * `EnqueuedTask`). So it does not establish "the swap index is gone" for anything that runs after
 * it — a caller that needs to know an index is empty has to READ, which is what
 * `countIndexDocuments` is for. Do not reintroduce a call to this before a rebuild and treat it as
 * a guarantee: the deletion lands AFTER the rebuild's `setup` has already read the old settings,
 * so the rebuild gets a bare auto-created index and the swap promotes one with no settings at all.
 *
 * `deleteIndexIfExists`, not `deleteIndex`: the latter rejects with `index_not_found`, and an absent
 * swap index is a reachable case on the path this runs on. Resolves to `false` when there was
 * nothing to delete, and to `undefined` when there is no client at all.
 */
const deleteSwapIndex = async ({
  swapIndexName,
  client = searchClient,
}: {
  swapIndexName: string;
  client?: MeiliSearch | null;
}) => {
  if (!client) {
    return;
  }

  return await client.deleteIndexIfExists(swapIndexName);
};

/**
 * How many documents an index holds, or `null` when there is no search client to ask.
 *
 * A READ, deliberately, and that is the whole point: Meilisearch mutations are tasks that complete
 * asynchronously, so no sequence of deletes can prove an index is empty at the moment a rebuild
 * starts writing into it. A stats read can, because it answers about now.
 *
 * An absent index counts as 0 rather than an error — "not there" and "there and empty" are the same
 * answer to the question the callers ask.
 */
const countIndexDocuments = async ({
  indexName,
  client = searchClient,
}: {
  indexName: string;
  client?: MeiliSearch | null;
}): Promise<number | null> => {
  if (!client) {
    return null;
  }

  try {
    const stats = await client.index(indexName).getStats();
    return stats.numberOfDocuments;
  } catch (e) {
    if ((e as MeiliSearchErrorInfo)?.code === 'index_not_found') return 0;
    throw e;
  }
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
 * Queue a user's content for batched removal from all search indexes.
 * Instead of creating 7 individual Meilisearch deletion tasks immediately,
 * this queues the user into Redis. A periodic job (processUserContentRemovalQueue)
 * drains the queue and batches multiple users into a single filter per index.
 */
export const removeUserContentFromSearchIndex = async ({
  userId,
  username,
}: {
  userId: number;
  username: string;
}) => {
  await sysRedis.hSet(REDIS_SYS_KEYS.QUEUES.USER_CONTENT_REMOVAL, userId.toString(), username);
  console.log(
    `removeUserContentFromSearchIndex :: Queued user ${userId} (${username}) for batch removal`
  );
};

/**
 * Process the queued user content removals in a single batch.
 * Combines multiple users into one filter per index using IN syntax,
 * reducing Meilisearch task count from N*len(indexes) to one per index.
 */
export const processUserContentRemovalQueue = async () => {
  const pending = await sysRedis.hGetAll(REDIS_SYS_KEYS.QUEUES.USER_CONTENT_REMOVAL);
  const entries = Object.entries(pending);

  if (entries.length === 0) return { processed: 0 };

  console.log(`processUserContentRemovalQueue :: Processing ${entries.length} users`);

  const userIds = entries.map(([id]) => parseInt(id));
  const usernames = entries.map(([, username]) => decodeRedisString(username));

  // Remove entries from queue before processing to avoid blocking new additions
  await sysRedis.hDel(
    REDIS_SYS_KEYS.QUEUES.USER_CONTENT_REMOVAL,
    entries.map(([id]) => id)
  );

  // Build escaped username list for filter
  const escapedUsernames = usernames
    .map((u) => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');
  const userIdList = userIds.join(', ');

  // One combined filter per index instead of one per user per index
  const mainIndexConfigs = [
    { name: MODELS_SEARCH_INDEX, filter: `user.id IN [${userIdList}]` },
    // IMAGES_SEARCH_INDEX is omitted deliberately: while it is retired no reset runs, so it has
    // no filterable attributes and a `user.username` filter errors. Re-add it only in the change
    // that resets the index — and it can hold documents before then, because
    // `pages/api/mod/search/images-update.ts` writes to it without consulting `retired`.
    { name: ARTICLES_SEARCH_INDEX, filter: `user.username IN [${escapedUsernames}]` },
    { name: COLLECTIONS_SEARCH_INDEX, filter: `user.username IN [${escapedUsernames}]` },
    { name: BOUNTIES_SEARCH_INDEX, filter: `user.username IN [${escapedUsernames}]` },
    { name: USERS_SEARCH_INDEX, filter: `id IN [${userIdList}]` },
    // Comics index uses `user.username` as its filterable attribute
    // (see `comics.search-index.ts` filterableAttributes). Without this
    // entry, banning a user leaves their comics indexed and reachable
    // through search even though the listing route would now hide them.
    { name: COMICS_SEARCH_INDEX, filter: `user.username IN [${escapedUsernames}]` },
  ];

  const metricsIndexConfigs = [
    { name: METRICS_IMAGES_SEARCH_INDEX, filter: `userId IN [${userIdList}]` },
  ];

  const processIndex = async (indexName: string, filter: string, client: MeiliSearch | null) => {
    if (!client) return;

    try {
      const index = await getOrCreateIndex(indexName, undefined, client);
      if (!index) return;

      console.log(
        `processUserContentRemovalQueue :: Deleting from ${indexName} with filter: ${filter}`
      );
      await index.deleteDocuments({ filter });
    } catch (error) {
      console.error(`processUserContentRemovalQueue :: Error on ${indexName}:`, error);
      await logToAxiom({
        name: 'process-user-content-removal-error',
        type: 'error',
        indexName,
        filter,
        userIds,
        error: error instanceof Error ? error.message : String(error),
      }).catch();
    }
  };

  await Promise.allSettled([
    ...mainIndexConfigs.map(({ name, filter }) => processIndex(name, filter, searchClient)),
    ...metricsIndexConfigs.map(({ name, filter }) =>
      processIndex(name, filter, metricsSearchClient)
    ),
  ]);

  await logToAxiom({
    name: 'process-user-content-removal-summary',
    type: 'info',
    userCount: entries.length,
    userIds,
  }).catch();

  console.log(
    `processUserContentRemovalQueue :: Completed batch removal for ${entries.length} users`
  );

  return { processed: entries.length };
};

export {
  swapIndex,
  deleteSwapIndex,
  countIndexDocuments,
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  waitForTasksWithRetries,
};
