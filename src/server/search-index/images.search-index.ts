import { client, updateDocs } from '~/server/meilisearch/client';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  waitForTasksWithRetries,
} from '~/server/meilisearch/util';
import {
  EnqueuedTask,
  FilterableAttributes,
  SearchableAttributes,
  SortableAttributes,
} from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import {
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  ImageIngestionStatus,
  MediaType,
  NsfwLevel,
  Prisma,
  PrismaClient,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
// import fs from 'fs';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 5000;
const INDEX_ID = IMAGES_SEARCH_INDEX;
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

  const searchableAttributes: SearchableAttributes = [
    'meta.prompt',
    'generationProcess',
    'tags.name',
    'user.username',
  ];

  const sortableAttributes: SortableAttributes = [
    'createdAt',
    'publishedAt',
    'rank.commentCountAllTimeRank',
    'rank.reactionCountAllTimeRank',
  ];

  const filterableAttributes: FilterableAttributes = ['tags.name', 'user.username'];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );

    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);

    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  if (
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

export type ImageSearchIndexRecord = Awaited<ReturnType<typeof onFetchItemsToIndex>>[number];

type ImageForSearchIndex = {
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
  tags: { tag: { id: number; name: string } }[];
  stats: {
    cryCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    likeCountAllTime: number;
    commentCountAllTime: number;
  } | null;
  rank: { commentCountAllTimeRank: number; reactionCountAllTimeRank: number } | null;
};

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  isIndexUpdate,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Sql[];
  cursor?: number;
  take?: number;
  isIndexUpdate?: boolean;
}) => {
  const offset = queryProps.cursor || -1;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range (Ids):`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );

  const WHERE = [
    Prisma.sql`i."id" > ${offset}`,
    Prisma.sql`i."postId" IS NOT NULL`,
    Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
    Prisma.sql`i."tosViolation" = false`,
    Prisma.sql`i."type" = 'image'`,
    Prisma.sql`i."scannedAt" IS NOT NULL`,
  ];

  if (whereOr) {
    WHERE.push(Prisma.sql`(${Prisma.join(whereOr, ' OR ')})`);
  }

  const images = await db.$queryRaw<ImageForSearchIndex[]>`
  WITH target AS MATERIALIZED (
    SELECT
    i."id",
    i."index",
    i."postId",
    i."name",
    i."url",
    i."nsfw",
    i."width",
    i."height",
    i."hash",
    i."meta",
    i."hideMeta",
    i."generationProcess",
    i."createdAt",
    i."mimeType",
    i."scannedAt",
    i."type",
    i."metadata",
    i."userId"
      FROM "Image" i
      WHERE ${Prisma.join(WHERE, ' AND ')}
    ORDER BY i."id"  
    LIMIT ${READ_BATCH_SIZE}
  ), ranks AS MATERIALIZED (
    SELECT
      ir."imageId",
      jsonb_build_object(
        'commentCountAllTimeRank', ir."commentCountAllTimeRank",
        'reactionCountAllTimeRank', ir."reactionCountAllTimeRank"
      ) rank
    FROM "ImageRank" ir
    WHERE ir."imageId" IN (SELECT id FROM target)
    GROUP BY ir."imageId"
  ), stats AS MATERIALIZED (
      SELECT
        im."imageId",
        jsonb_build_object(
          'commentCountAllTime', SUM("commentCount"),
          'laughCountAllTime', SUM("laughCount"),
          'heartCountAllTime', SUM("heartCount"),
          'dislikeCountAllTime', SUM("dislikeCount"),
          'likeCountAllTime', SUM("likeCount"),
          'cryCountAllTime', SUM("cryCount")
        ) stats
      FROM "ImageMetric" im 
      WHERE im."imageId" IN (SELECT id FROM target) 
      GROUP BY im."imageId"
  ), users AS MATERIALIZED (
    SELECT
      u.id,
      jsonb_agg(jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'deletedAt', u."deletedAt",
        'image', u.image
      )) user
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
  )
  SELECT
    t.*,
    (SELECT rank FROM ranks r WHERE r."imageId" = t.id), 
    (SELECT stats FROM stats s WHERE s."imageId" = t.id),
    (SELECT user FROM users u WHERE u.id = t."userId"),
    (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
  FROM target t`;

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (images.length === 0) {
    return [];
  }

  const rawTags = await db.imageTag.findMany({
    where: { imageId: { in: images.map((i) => i.id) }, concrete: true },
    select: {
      imageId: true,
      tagId: true,
      tagName: true,
    },
  });

  // No need for this to ever happen during reset or re-index.
  if (isIndexUpdate) {
    // Determine if we need to update the model index based on any of these images
    const affectedModels = await db.$queryRaw<{ modelId: number }[]>`
    SELECT
      m.id "modelId"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId" AND p."modelVersionId" IS NOT NULL AND p."publishedAt" IS NOT NULL
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId" AND i."userId" = m."userId"
    WHERE i.id IN (${Prisma.join(images.map(({ id }) => id))})
  `;

    const affectedModelIds = [...new Set(affectedModels.map(({ modelId }) => modelId))];

    await modelsSearchIndex.queueUpdate(
      affectedModelIds.map((id) => ({
        id: id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  }

  const indexReadyRecords = images.map(({ user, cosmetics, meta, ...imageRecord }) => {
    const parsed = imageMetaSchema.safeParse(meta);

    return {
      ...imageRecord,
      // Flatten tags:
      meta: parsed.success ? parsed.data : {},
      user: {
        ...user,
        cosmetics: (cosmetics || []).map((cosmetic) => ({ cosmetic })),
      },
      tags: rawTags
        .filter((rt) => rt.imageId === imageRecord.id)
        .map((rt) => ({ id: rt.tagId, name: rt.tagName })),
      reactions: [],
    };
  });

  // write to file
  // const file = fs.createWriteStream(`./images-${offset}-${offset + READ_BATCH_SIZE}.json`);
  // file.write(JSON.stringify(indexReadyRecords));
  // file.end();

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

  const itemsToIndex: ImageSearchIndexRecord[] = [];

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queuedItems.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const itemIds = batch.map(({ id }) => id);

    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [Prisma.sql`i.id IN ${Prisma.join(itemIds)}`],
      isIndexUpdate: true,
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

  let offset = -1; // such that it starts on 0.
  const imageTasks: EnqueuedTask[] = [];

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
      imageTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      cursor: offset,
      whereOr: lastUpdatedAt
        ? [
            Prisma.sql`i."createdAt" > ${lastUpdatedAt}`,
            Prisma.sql`i."updatedAt" > ${lastUpdatedAt}`,
          ]
        : undefined,
      isIndexUpdate: !!lastUpdatedAt,
    });

    // Avoids hitting the DB without data.
    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    imageTasks.push(...tasks);

    // Update offset to last index recorded.
    offset = indexReadyRecords[indexReadyRecords.length - 1].id;
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
