import { updateDocs } from '~/server/meilisearch/client';
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
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  LinkType,
  MediaType,
  NsfwLevel,
  Prisma,
  PrismaClient,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { COLLECTIONS_SEARCH_INDEX } from '~/server/common/constants';
import { getCollectionItemsByCollectionId } from '~/server/services/collection.service';
import { isDefined } from '~/utils/type-guards';
import { uniqBy } from 'lodash-es';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = COLLECTIONS_SEARCH_INDEX;
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['name'];

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
    'metrics.itemCount',
    'metrics.followerCount',
    'metrics.contributorCount',
  ];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'attribute', 'words', 'proximity', 'exactness', 'typo'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  const filterableAttributes = ['user.username', 'type'];

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

export type CollectionSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];
type CollectionForSearchIndex = {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  type: CollectionType;
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
  userId: number;
  metrics: {
    followerCount: number;
    itemCount: number;
    contributorCount: number;
  };
  user: {
    id: number;
    image: string | null;
    username: string | null;
    deletedAt: Date | null;
  };
  cosmetics: {
    data: Prisma.JsonValue;
    type: CosmeticType;
    id: number;
    name: string;
    source: CosmeticSource;
  }[];
  image: {
    type: MediaType;
    id: number;
    generationProcess: ImageGenerationProcess | null;
    createdAt: Date;
    name: string | null;
    url: string;
    meta: Prisma.JsonValue;
    hash: string | null;
    height: number | null;
    width: number | null;
    metadata: Prisma.JsonValue;
    nsfw: NsfwLevel;
    postId: number | null;
    needsReview: string | null;
    hideMeta: boolean;
    index: number | null;
    scannedAt: Date | null;
    mimeType: string | null;
  } | null;
};

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Sql[];
  skip?: number;
}) => {
  const offset = queryProps.skip || 0;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );

  const WHERE = [
    Prisma.sql`c."userId" != -1`,
    Prisma.sql`c.read = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"`,
    // Don't index empty collections:
    Prisma.sql`EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)`,
  ];

  if (whereOr) {
    WHERE.push(Prisma.sql`(${Prisma.join(whereOr, ' OR ')})`);
  }

  // When metrics are ready use this one :D
  const collections = await db.$queryRaw<CollectionForSearchIndex[]>`
  WITH target AS MATERIALIZED (
    SELECT
    c.id,
    c.name,
    c."imageId",
    c."createdAt",
    c."updatedAt",
    c."userId",
    c."type",    
    c."read",    
    c."write"
    FROM "Collection" c
    WHERE ${Prisma.join(WHERE, ' AND ')}
    OFFSET ${offset} LIMIT ${READ_BATCH_SIZE}
  ), users AS MATERIALIZED (
    SELECT
      u.id,
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'deletedAt', u."deletedAt",
        'image', u.image
      ) user
    FROM "User" u
    WHERE u.id IN (SELECT "userId" FROM target)
    GROUP BY u.id
  ), cosmetics AS MATERIALIZED (
    SELECT
      uc."userId",
      jsonb_agg(jsonb_build_object(
        'id', c.id,
        'data', c.data,
        'type', c.type,
        'source', c.source,
        'name', c.name,
        'leaderboardId', c."leaderboardId",
        'leaderboardPosition', c."leaderboardPosition"
      )) cosmetics
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    AND "equippedAt" IS NOT NULL
    WHERE uc."userId" IN (SELECT "userId" FROM target)
    GROUP BY uc."userId"
  ), images AS MATERIALIZED (
    SELECT
      i.id,
      jsonb_build_object(
        'id', i."id",
        'index', i."index",
        'postId', i."postId",
        'name', i."name",
        'url', i."url",
        'nsfw', i."nsfw",
        'width', i."width",
        'height', i."height",
        'hash', i."hash",
        'meta', i."meta",
        'hideMeta', i."hideMeta",
        'generationProcess', i."generationProcess",
        'createdAt', i."createdAt",
        'mimeType', i."mimeType",
        'scannedAt', i."scannedAt",
        'type', i."type",
        'metadata', i."metadata"
      ) image
    FROM "Image" i
    WHERE i.id IN (SELECT "imageId" FROM target)
    GROUP BY i.id
  ), metrics as MATERIALIZED (
    SELECT
      cm."collectionId",
      jsonb_build_object(
        'followerCount', cm."followerCount",
        'itemCount', cm."itemCount",
        'contributorCount', cm."contributorCount"
      ) metrics
    FROM "CollectionMetric" cm
    WHERE cm.timeframe = 'AllTime'
      AND cm."collectionId" IN (SELECT id FROM target)
  )
  SELECT
    t.*,
    (SELECT metrics FROM metrics m WHERE m."collectionId" = t.id),
    (SELECT "image" FROM images i WHERE i.id = t."imageId"),
    (SELECT "user" FROM users u WHERE u.id = t."userId"),
    (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
  FROM target t
  `;

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (collections.length === 0) {
    return [];
  }

  const collectionItemImages = await Promise.all(
    collections.map(async (c) => {
      const images = [];
      const srcs = [];
      if (c.image) {
        images.push(c.image);
      } else {
        const items = await getCollectionItemsByCollectionId({
          input: {
            collectionId: c.id,
            limit: 10,
          },
        });

        const itemImages = uniqBy(
          items
            .map((item) => {
              switch (item.type) {
                case 'model':
                  return item.data.images[0];
                case 'post':
                  return item.data.image;
                case 'image':
                  return item.data;
                case 'article':
                default:
                  return null;
              }
            })
            .filter(isDefined),
          'id'
        );

        const itemsSrcs = items
          .map((item) => {
            switch (item.type) {
              case 'article':
                return item.data.cover;
              case 'model':
              case 'post':
              case 'image':
              default:
                return null;
            }
          })
          .filter(isDefined);

        images.push(...itemImages);
        srcs.push(...itemsSrcs);
      }

      return {
        id: c.id,
        images,
        srcs,
      };
    })
  );

  const indexReadyRecords = collections.map((collection) => {
    const cosmetics = collection.cosmetics ?? [];
    const collectionImages = collectionItemImages.find((ci) => ci.id === collection.id);

    return {
      ...collection,
      metrics: collection.metrics || {},
      user: {
        ...collection.user,
        cosmetics: cosmetics.map((cosmetic) => ({ cosmetic })),
      },
      images: collectionImages?.images ?? [],
      srcs: collectionImages?.srcs ?? [],
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

  const itemsToIndex: CollectionSearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queuedItems.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const itemIds = batch.map(({ id }) => id);

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [Prisma.sql`u.id IN (${Prisma.join(itemIds)})`],
    });

    itemsToIndex.push(...newItems);
  }

  return itemsToIndex;
};
const onIndexUpdate = async ({ db, lastUpdatedAt, indexName }: SearchIndexRunContext) => {
  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  let offset = 0;
  const collectionTasks: EnqueuedTask[] = [];

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
      collectionTasks.push(...updateBaseTasks);
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
      whereOr: !lastUpdatedAt ? undefined : [Prisma.sql`u."createdAt" > ${lastUpdatedAt}`],
    });

    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    collectionTasks.push(...tasks);

    offset += indexReadyRecords.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(collectionTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const collectionsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
