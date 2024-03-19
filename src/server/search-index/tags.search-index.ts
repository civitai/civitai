import { client, updateDocs } from '~/server/meilisearch/client';
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
import { MetricTimeframe, Prisma, PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { isDefined } from '~/utils/type-guards';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 100;
const INDEX_ID = 'tags';
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;
/*
  Only tags above this threshold will be indexed.
 */
const MINIMUM_METRICS_COUNT = 10;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes(['name']);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'metrics.modelCount',
    'metrics.imageCount',
    'createdAt',
    'metrics.postCount',
    'metrics.articleCount',
    'metrics.followerCount',
    'metrics.hiddenCount',
  ]);

  const updateRankingRulesTask = await index.updateRankingRules([
    'attribute',
    'metrics.modelCount:desc',
    'metrics.imageCount:desc',
    'words',
    'proximity',
    'sort',
    'exactness',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);
  console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  console.log('onIndexSetup :: all tasks completed');
};

export type TagSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.TagWhereInput[];
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

  const tags = await db.tag.findMany({
    skip: offset,
    take: READ_BATCH_SIZE,
    select: {
      id: true,
      name: true,
      nsfw: true,
      isCategory: true,
      createdAt: true,
      metrics: {
        select: {
          postCount: true,
          articleCount: true,
          followerCount: true,
          modelCount: true,
          imageCount: true,
          hiddenCount: true,
        },
        where: {
          timeframe: MetricTimeframe.AllTime,
        },
      },
    },
    where: {
      unlisted: false,
      adminOnly: false,
      // if lastUpdatedAt is not provided,
      // this should generate the entirety of the index.
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
  if (tags.length === 0) {
    return [];
  }

  const indexReadyRecords = tags
    .map((tagRecord) => {
      const metrics = tagRecord.metrics[0];
      //perhaps posts + articles + model + imageCounts
      const metricsCount = metrics
        ? metrics.articleCount + metrics.postCount + metrics.modelCount + metrics.imageCount
        : 0;

      if (metricsCount < MINIMUM_METRICS_COUNT) {
        return null;
      }

      return {
        ...tagRecord,
        metrics: {
          // Flattens metric array
          ...(tagRecord.metrics[0] || {}),
        },
      };
    })
    .filter(isDefined);

  return indexReadyRecords;
};

const onUpdateQueueProcess = async ({ db, indexName }: { db: PrismaClient; indexName: string }) => {
  const queue = await SearchIndexUpdate.getQueue(indexName, SearchIndexUpdateQueueAction.Update);

  console.log(
    'onUpdateQueueProcess :: A total of ',
    queue.content.length,
    ' have been updated and will be re-indexed'
  );

  const batchCount = Math.ceil(queue.content.length / READ_BATCH_SIZE);

  const itemsToIndex: TagSearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queue.content.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [{ id: { in: batch } }],
    });

    itemsToIndex.push(...newItems);
  }

  await queue.commit();
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
  const tagTasks: EnqueuedTask[] = [];

  if (lastUpdatedAt) {
    // Only if this is an update (NOT a reset or first run) will we care for queued items:

    // Update whatever items we have on the queue.
    // Do it on batches, since it's possible that there are far more items than we expect:
    const updateTasks = await onUpdateQueueProcess({
      db,
      indexName,
    });

    if (updateTasks.length > 0) {
      const updateBaseTasks = await updateDocs({
        indexName,
        documents: updateTasks,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      });

      console.log('onIndexUpdate :: base tasks for updated items have been added');
      tagTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
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
            {
              updatedAt: {
                gt: lastUpdatedAt,
              },
            },
          ],
    });

    // Avoids hitting the DB without data.
    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    tagTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(tagTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const tagsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
