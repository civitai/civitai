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
import { ImageIngestionStatus, MetricTimeframe } from '@prisma/client';
import { imageSelect } from '~/server/selectors/image.selector';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 100;
const INDEX_ID = 'images';
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

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'meta.prompt',
    'tags',
    'user.username',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'createdAt',
    'metric.commentCount',
    'metric.laughCount',
    'metric.heartCount',
    'metric.dislikeCount',
    'metric.likeCount',
    'metric.cryCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

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
  const imageTasks: EnqueuedTask[] = [];

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

    const images = await db.image.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
      select: {
        ...imageSelect,
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        metrics: {
          select: {
            commentCount: true,
            laughCount: true,
            heartCount: true,
            dislikeCount: true,
            likeCount: true,
            cryCount: true,
          },
          where: {
            timeframe: MetricTimeframe.AllTime,
          },
        },
      },
      where: {
        ingestion: ImageIngestionStatus.Scanned,
        tosViolation: false,
        scannedAt: {
          not: null,
        },
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
                updatedAt: {
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
    if (images.length === 0) break;

    const indexReadyRecords = images.map(({ tags, ...imageRecord }) => {
      return {
        ...imageRecord,
        metrics: {
          // Flattens metric array
          ...(imageRecord.metrics[0] || {}),
        },
        // Flatten tags:
        tags: tags.map((imageTag) => imageTag.tag.name),
      };
    });

    const tasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);

    imageTasks.push(...tasks);

    offset += images.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(imageTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const imagesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
