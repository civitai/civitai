import { client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { Availability, Prisma, PrismaClient } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = ARTICLES_SEARCH_INDEX;
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

  const settings = await index.getSettings();

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'title',
    'content',
    'tags.name',
    'user.username',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'createdAt',
    'stats.commentCount',
    'stats.favoriteCount',
    'stats.viewCount',
    'stats.tippedAmountCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  const filterableAttributes = ['tags.name', 'user.username', 'nsfwLevel'];

  if (
    // Meilisearch stores sorted.
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

export type ArticleSearchIndexRecord = Awaited<
  ReturnType<typeof onFetchItemsToIndex>
>['indexReadyRecords'][number];

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.ArticleWhereInput[];
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

  const articles = await db.article.findMany({
    skip: offset,
    take: READ_BATCH_SIZE,
    select: {
      ...articleDetailSelect,
      stats: {
        select: {
          favoriteCountAllTime: true,
          commentCountAllTime: true,
          likeCountAllTime: true,
          dislikeCountAllTime: true,
          heartCountAllTime: true,
          laughCountAllTime: true,
          cryCountAllTime: true,
          viewCountAllTime: true,
          tippedAmountCountAllTime: true,
        },
      },
    },
    where: {
      publishedAt: {
        not: null,
      },
      tosViolation: false,
      availability: {
        not: Availability.Unsearchable,
      },
      // if lastUpdatedAt is not provided,
      // this should generate the entirety of the index.
      OR: (whereOr?.length ?? 0) > 0 ? whereOr : undefined,
    },
  });

  const cosmetics = await getCosmeticsForEntity({
    ids: articles.map((x) => x.id),
    entity: 'Article',
  });

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  const records = articles
    .map(({ tags, stats, ...articleRecord }) => {
      const coverImage = articleRecord.coverImage;
      if (!coverImage) return null;
      return {
        ...articleRecord,
        nsfwLevel: parseBitwiseBrowsingLevel(articleRecord.nsfwLevel),
        stats: stats
          ? {
              favoriteCount: stats.favoriteCountAllTime,
              commentCount: stats.commentCountAllTime,
              likeCount: stats.likeCountAllTime,
              dislikeCount: stats.dislikeCountAllTime,
              heartCount: stats.heartCountAllTime,
              laughCount: stats.laughCountAllTime,
              cryCount: stats.cryCountAllTime,
              viewCount: stats.viewCountAllTime,
              tippedAmountCount: stats.tippedAmountCountAllTime,
            }
          : undefined,
        // Flatten tags:
        tags: tags.map((articleTag) => articleTag.tag),
        coverImage: {
          ...coverImage,
          meta: coverImage.meta as ImageMetaProps,
          tags: coverImage.tags.map((x) => x.tag),
        },
        cosmetic: cosmetics[articleRecord.id] ?? null,
      };
    })
    .filter(isDefined);

  const toRequeue = records.filter((x) => x.coverImage.ingestion !== 'Scanned');
  const indexReadyRecords = records.filter((x) => x.coverImage.ingestion === 'Scanned');

  return { toRequeue, indexReadyRecords };
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
  const articlesTasks: EnqueuedTask[] = [];

  const queuedUpdates = await SearchIndexUpdate.getQueue(
    indexName,
    SearchIndexUpdateQueueAction.Update
  );
  const queuedDeletes = await SearchIndexUpdate.getQueue(
    indexName,
    SearchIndexUpdateQueueAction.Delete
  );

  const toQueue = new Set<number>();
  while (true) {
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );
    const { toRequeue, indexReadyRecords } = await onFetchItemsToIndex({
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
            {
              id: {
                in: [...queuedUpdates.content, ...queuedDeletes.content],
              },
            },
          ],
    });

    if (toRequeue.length) {
      for (const item of toRequeue) toQueue.add(item.id);
    }

    console.log(
      `onIndexUpdate :: fetching complete for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });
    articlesTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  // Queue requeued items
  await SearchIndexUpdate.queueUpdate({
    indexName,
    items: [...toQueue].map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
  });

  // Commit all queued updates and deletes
  await Promise.all([queuedUpdates.commit, queuedDeletes.commit]);

  console.log('onIndexUpdate :: index update complete');
};

export const articlesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
