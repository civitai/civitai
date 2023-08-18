import { client } from '~/server/meilisearch/client';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  waitForTasksWithRetries,
} from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import {
  MetricTimeframe,
  Prisma,
  PrismaClient,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = USERS_SEARCH_INDEX;
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const RATING_BAYESIAN_M = 3.5;
const RATING_BAYESIAN_C = 10;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['username'];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  const sortableAttributes = [
    'createdAt',
    'stats.weightedRating',
    'stats.followerCountAllTime',
    'stats.uploadCountAllTime',
  ];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'attribute', 'words', 'typo', 'proximity', 'exactness'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  // Uncomment & Add if we want to filter by some attribute at some point.
  // const filterableAttributes = [];
  //
  // if (
  //   // Meilisearch stores sorted.
  //   JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  // ) {
  //   const updateFilterableAttributesTask = await index.updateFilterableAttributes(
  //     filterableAttributes
  //   );
  //
  //   console.log(
  //     'onIndexSetup :: updateFilterableAttributesTask created',
  //     updateFilterableAttributesTask
  //   );
  // }

  console.log('onIndexSetup :: all tasks completed');
};

export type UserSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Enumerable<Prisma.UserWhereInput>;
  skip?: number;
  take?: number;
}) => {
  const offset = queryProps.skip || 0;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );

  const users = await db.user.findMany({
    skip: offset,
    take: READ_BATCH_SIZE,
    select: {
      ...userWithCosmeticsSelect,
      createdAt: true,
      rank: {
        select: {
          leaderboardRank: true,
          leaderboardId: true,
          leaderboardTitle: true,
          leaderboardCosmetic: true,
        },
      },
      links: {
        select: {
          url: true,
          type: true,
        },
      },
      stats: {
        select: {
          ratingAllTime: true,
          ratingCountAllTime: true,
          downloadCountAllTime: true,
          favoriteCountAllTime: true,
          followerCountAllTime: true,
          answerAcceptCountAllTime: true,
          answerCountAllTime: true,
          followingCountAllTime: true,
          hiddenCountAllTime: true,
          reviewCountAllTime: true,
          uploadCountAllTime: true,
        },
      },
      metrics: {
        select: {
          followerCount: true,
          uploadCount: true,
          followingCount: true,
          reviewCount: true,
          answerAcceptCount: true,
          hiddenCount: true,
          answerCount: true,
        },
        where: {
          timeframe: MetricTimeframe.AllTime,
        },
      },
    },
    where: {
      id: {
        not: -1,
      },
      deletedAt: null,
      OR: whereOr,
    },
  });

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (users.length === 0) {
    return [];
  }

  const indexReadyRecords = users.map((userRecord) => {
    const stats = userRecord.stats;

    const weightedRating = !stats
      ? 0
      : (stats.ratingAllTime * stats.ratingCountAllTime + RATING_BAYESIAN_M * RATING_BAYESIAN_C) /
        (stats.ratingCountAllTime + RATING_BAYESIAN_C);

    return {
      ...userRecord,
      stats: stats
        ? {
            ...stats,
            weightedRating,
          }
        : null,
      metrics: {
        // Flattens metric array
        ...(userRecord.metrics[0] || {}),
      },
    };
  });

  return indexReadyRecords;
};

const onUpdateQueueProcess = async ({ db, indexName }: { db: PrismaClient; indexName: string }) => {
  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: { type: INDEX_ID, action: SearchIndexUpdateQueueAction.Update },
  });

  console.log(
    'onUpdateQueueProcess :: A total of ',
    queuedItems.length,
    ' have been updated and will be re-indexed'
  );

  const batchCount = Math.ceil(queuedItems.length / READ_BATCH_SIZE);

  const itemsToIndex: UserSearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queuedItems.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const itemIds = batch.map(({ id }) => id);

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: {
        id: {
          in: itemIds,
        },
      },
    });

    itemsToIndex.push(...newItems);
  }

  return itemsToIndex;
};
const onIndexUpdate = async ({ db, lastUpdatedAt, indexName }: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  let offset = 0;
  const userTasks: EnqueuedTask[] = [];

  if (lastUpdatedAt) {
    // Only if this is an update (NOT a reset or first run) will we care for queued items:

    // Update whatever items we have on the queue.
    // Do it on batches, since it's possible that there are far more items than we expect:
    const updateTasks = await onUpdateQueueProcess({
      db,
      indexName,
    });

    if (updateTasks.length > 0) {
      const updateBaseTasks = await client
        .index(indexName)
        .updateDocumentsInBatches(updateTasks, MEILISEARCH_DOCUMENT_BATCH_SIZE);

      console.log('onIndexUpdate :: base tasks for updated items have been added');
      userTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      skip: offset,
      whereOr: !lastUpdatedAt
        ? undefined
        : [
            {
              createdAt: {
                gt: lastUpdatedAt,
              },
            },
          ],
    });

    if (indexReadyRecords.length === 0) break;

    const tasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);

    userTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(userTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const usersSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
