import { client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
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
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { chunk } from 'lodash-es';
import { withRetries } from '~/server/utils/errorHandling';
import {
  ImageModelWithIngestion,
  imageSelect,
  profileImageSelect,
} from '../selectors/image.selector';
import { isDefined } from '~/utils/type-guards';
import { NsfwLevel } from '~/server/common/enums';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
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
    'tagNames',
    'user.username',
  ];

  const sortableAttributes: SortableAttributes = [
    'createdAt',
    'stats.commentCountAllTime',
    'stats.reactionCountAllTime',
    'stats.collectedCountAllTime',
    'stats.tippedAmountCountAllTime',
  ];

  const filterableAttributes: FilterableAttributes = [
    'createdAtUnix',
    'tagNames',
    'user.username',
    'baseModel',
    'generationTool',
    'aspectRatio',
    'nsfwLevel',
  ];

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
  nsfwLevel: NsfwLevel;
  postId: number | null;
  needsReview: string | null;
  hideMeta: boolean;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  modelVersionId: number | null;
  baseModel?: string | null;
  user: {
    id: number;
    image: string | null;
    username: string | null;
    deletedAt: Date | null;
    profilePictureId: number | null;
    profilePicture: ImageModelWithIngestion | null;
  };
  cosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
  tagNames: string[];
  tagIds: number[];
  stats: {
    cryCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    likeCountAllTime: number;
    reactionCountAllTime: number;
    commentCountAllTime: number;
    collectedCountAllTime: number;
    tippedAmountCountAllTime: number;
  } | null;
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
  return withRetries(
    async () => {
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
        Prisma.sql`i."needsReview" IS NULL`,
        Prisma.sql`p."publishedAt" IS NOT NULL`,
        Prisma.sql`p.metadata->>'unpublishedAt' IS NULL`,
        Prisma.sql`p."availability" != 'Private'::"Availability"`,
        Prisma.sql`p."availability" != 'Unsearchable'::"Availability"`,
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
    i."nsfwLevel",
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
    i."userId",
    p."modelVersionId",
    (
      SELECT mv."baseModel" FROM "ModelVersion" mv
      RIGHT JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE m."type" = 'Checkpoint'
      LIMIT 1
    ) "baseModel"
      FROM "Image" i
      JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
      WHERE ${Prisma.join(WHERE, ' AND ')}
    ORDER BY i."id"
    LIMIT ${READ_BATCH_SIZE}
  ), stats AS MATERIALIZED (
      SELECT
        im."imageId",
        jsonb_build_object(
          'commentCountAllTime', SUM("commentCount"),
          'laughCountAllTime', SUM("laughCount"),
          'heartCountAllTime', SUM("heartCount"),
          'dislikeCountAllTime', SUM("dislikeCount"),
          'likeCountAllTime', SUM("likeCount"),
          'cryCountAllTime', SUM("cryCount"),
          'reactionCountAllTime', SUM("reactionCount"),
          'collectedCountAllTime', SUM("collectedCount"),
          'tippedAmountCountAllTime', SUM("tippedAmountCount")
        ) stats
      FROM "ImageMetric" im
      WHERE im."imageId" IN (SELECT id FROM target)
        AND im."timeframe" = 'AllTime'::"MetricTimeframe"
      GROUP BY im."imageId"
  ), users AS MATERIALIZED (
    SELECT
      u.id,
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'deletedAt', u."deletedAt",
        'image', u.image,
        'profilePictureId', u."profilePictureId"
      ) user
    FROM "User" u
    WHERE u.id IN (SELECT "userId" FROM target)
    GROUP BY u.id
  ), cosmetics AS MATERIALIZED (
    SELECT
      uc."userId",
      jsonb_agg(
        jsonb_build_object(
          'data', uc.data,
          'cosmetic', jsonb_build_object(
            'id', c.id,
            'data', c.data,
            'type', c.type,
            'source', c.source,
            'name', c.name,
            'leaderboardId', c."leaderboardId",
            'leaderboardPosition', c."leaderboardPosition"
          )
        )
      )  cosmetics
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    AND "equippedAt" IS NOT NULL
    WHERE uc."userId" IN (SELECT "userId" FROM target) AND uc."equippedToId" IS NULL
    GROUP BY uc."userId"
  )
  SELECT
    t.*,
    (SELECT stats FROM stats s WHERE s."imageId" = t.id),
    (SELECT "user" FROM users u WHERE u.id = t."userId"),
    (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
  FROM target t`;

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

      const profilePictures = await db.image.findMany({
        where: { id: { in: images.map((i) => i.user.profilePictureId).filter(isDefined) } },
        select: profileImageSelect,
      });

      const imageCosmetics = await getCosmeticsForEntity({
        ids: images.map((i) => i.id),
        entity: 'Image',
      });

      console.log(
        `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
        offset,
        offset + READ_BATCH_SIZE - 1,
        'filters:',
        whereOr
      );

      // No need for this to ever happen during reset or re-index.
      if (isIndexUpdate) {
        // Determine if we need to update the model index based on any of these images
        const affectedModels = await db.$queryRaw<{ modelId: number }[]>`
          SELECT
            m.id "modelId"
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId" AND p."modelVersionId" IS NOT NULL AND p."publishedAt" IS NOT NULL AND p.metadata->>'unpublishedAt' IS NULL
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
        const parsed = imageGenerationSchema
          .omit({ comfy: true, hashes: true })
          .partial()
          .safeParse(meta);
        const tags = rawTags
          .filter((rt) => rt.imageId === imageRecord.id)
          .map((rt) => ({ id: rt.tagId, name: rt.tagName }));
        const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;

        return {
          ...imageRecord,
          nsfwLevel: parseBitwiseBrowsingLevel(imageRecord.nsfwLevel),
          createdAtUnix: imageRecord.createdAt.getTime(),
          aspectRatio:
            !imageRecord.width || !imageRecord.height
              ? 'Unknown'
              : imageRecord.width > imageRecord.height
              ? 'Landscape'
              : imageRecord.width < imageRecord.height
              ? 'Portrait'
              : 'Square',
          generationTool: meta?.hasOwnProperty('comfy')
            ? 'Comfy'
            : meta?.hasOwnProperty('prompt')
            ? 'Automatic1111'
            : 'Unknown',
          meta: parsed.success ? parsed.data : {},
          user: {
            ...user,
            cosmetics: cosmetics ?? [],
            profilePicture,
          },
          tagNames: tags.map((t) => t.name),
          tagIds: tags.map((t) => t.id),
          reactions: [],
          cosmetic: imageCosmetics[imageRecord.id] ?? null,
        };
      });

      return indexReadyRecords;
    },
    3,
    1500
  );
};

const onUpdateQueueProcess = async ({ db, indexName }: { db: PrismaClient; indexName: string }) => {
  const queue = await SearchIndexUpdate.getQueue(indexName, SearchIndexUpdateQueueAction.Update);

  console.log(
    'onUpdateQueueProcess :: A total of ',
    queue.content.length,
    ' have been updated and will be re-indexed'
  );

  const itemsToIndex: ImageSearchIndexRecord[] = [];
  const batches = chunk(queue.content, READ_BATCH_SIZE);
  for (const batch of batches) {
    const newItems = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: [Prisma.sql`i.id IN (${Prisma.join(batch)})`],
      isIndexUpdate: true,
    });

    itemsToIndex.push(...newItems);
  }

  await queue.commit();
  return itemsToIndex;
};

const onIndexUpdate = async ({
  db,
  lastUpdatedAt,
  indexName,
  jobContext,
}: SearchIndexRunContext) => {
  // Confirm index setup & working:
  await onIndexSetup({ indexName });
  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await withRetries(
    async () => await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID }),
    3,
    1500
  );

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
        // jobContext,
      });

      console.log('onIndexUpdate :: base tasks for updated items have been added');
      imageTasks.push(...updateBaseTasks);
    }
  }

  while (true) {
    // jobContext.checkIfCanceled();
    const indexReadyRecords = await onFetchItemsToIndex({
      db,
      indexName,
      cursor: offset,
      whereOr: lastUpdatedAt ? [Prisma.sql`i."createdAt" > ${lastUpdatedAt}`] : undefined,
      isIndexUpdate: !!lastUpdatedAt,
    });

    // Avoids hitting the DB without data.
    if (indexReadyRecords.length === 0) break;

    const tasks = await updateDocs({
      indexName,
      documents: indexReadyRecords,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      // jobContext,
    });

    imageTasks.push(...tasks);

    // Update offset to last index recorded.
    offset = indexReadyRecords[indexReadyRecords.length - 1].id;
  }

  console.log('onIndexUpdate :: index update complete');
};

export const imagesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
