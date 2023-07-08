import { client } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { MetricTimeframe } from '@prisma/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = 'users';
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes(['username']);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'stats.ratingAllTime',
    'stats.ratingCountAllTime',
    'createdAt',
    'stats.downloadCountAllTime',
    'stats.favoriteCountAllTime',
    'stats.followerCountAllTime',
    'stats.answerAcceptCountAllTime',
    'stats.answerCountAllTime',
    'stats.followingCountAllTime',
    'stats.hiddenCountAllTime',
    'stats.reviewCountAllTime',
    'stats.uploadCountAllTime',
    'metrics.followerCount',
    'metrics.uploadCount',
    'metrics.followingCount',
    'metrics.reviewCount',
    'metrics.answerAcceptCount',
    'metrics.hiddenCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  const updateRankingRulesTask = await index.updateRankingRules([
    'attribute',
    'metrics.followerCount:desc',
    'stats.ratingAllTime:desc',
    'stats.ratingCountAllTime:desc',
    'words',
    'typo',
    'proximity',
    'sort',
    'exactness',
  ]);

  console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);

  console.log('onIndexSetup :: all tasks completed');
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

  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: {
      type: INDEX_ID,
    },
  });

  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );
    const users = await db.user.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
      select: {
        ...userWithCosmeticsSelect,
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
        // if lastUpdatedAt is not provided,
        // this should generate the entirety of the index.
        OR: !lastUpdatedAt
          ? undefined
          : [
              {
                createdAt: {
                  gt: lastUpdatedAt,
                },
              },
              {
                id: {
                  in: queuedItems.map(({ id }) => id),
                },
              },
            ],
      },
    });
    console.log(
      `onIndexUpdate :: fetching complete for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    // Avoids hitting the DB without data.
    if (users.length === 0) break;

    const indexReadyRecords = users.map((userRecord) => {
      return {
        ...userRecord,
        metrics: {
          // Flattens metric array
          ...(userRecord.metrics[0] || {}),
        },
      };
    });

    const tasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);

    userTasks.push(...tasks);

    offset += users.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await client.waitForTasks(userTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const usersSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
