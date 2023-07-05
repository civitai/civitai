import { client } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { MetricTimeframe } from '@prisma/client';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { articleDetailSelect } from '~/server/selectors/article.selector';

const READ_BATCH_SIZE = 1000;
const INDEX_ID = 'articles';
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName);
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'title',
    'content',
    'tags',
    'user.username',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'createdAt',
    'metrics.commentCount',
    'metrics.cryCount',
    'metrics.dislikeCount',
    'metrics.favoriteCount',
    'metrics.heartCount',
    'metrics.hideCount',
    'metrics.laughCount',
    'metrics.viewCount',
    'metrics.likeCount',
    'stats.viewCountAllTime',
    'stats.commentCountAllTime',
    'stats.likeCountAllTime',
    'stats.dislikeCountAllTime',
    'stats.heartCountAllTime',
    'stats.laughCountAllTime',
    'stats.cryCountAllTime',
    'stats.favoriteCountAllTime',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  await client.waitForTasks([
    updateSearchableAttributesTask.taskUid,
    sortableFieldsAttributesTask.taskUid,
  ]);

  console.log('onIndexSetup :: all tasks completed');
};

const onIndexUpdate = async ({ db, lastUpdatedAt, indexName }: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup({ indexName });

  let offset = 0;
  const tagTasks: EnqueuedTask[] = [];

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
    const articles = await db.article.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
      select: {
        ...articleDetailSelect,
        metrics: {
          select: {
            commentCount: true,
            cryCount: true,
            dislikeCount: true,
            favoriteCount: true,
            heartCount: true,
            hideCount: true,
            laughCount: true,
            viewCount: true,
            likeCount: true,
          },
          where: {
            timeframe: MetricTimeframe.AllTime,
          },
        },
      },
      where: {
        tosViolation: false,
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
    if (articles.length === 0) break;

    const indexReadyRecords = articles.map(({ tags, ...articleRecord }) => {
      return {
        ...articleRecord,
        metrics: {
          // Flattens metric array
          ...(articleRecord.metrics[0] || {}),
        },
        // Flatten tags:
        tags: tags.map((articleTag) => articleTag.tag.name),
      };
    });

    tagTasks.push(await client.index(`${INDEX_ID}`).updateDocuments(indexReadyRecords));

    offset += articles.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await client.waitForTasks(tagTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const articlesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
