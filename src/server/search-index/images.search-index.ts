import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { clickhouse } from '~/server/clickhouse/client';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import {
  tagCache,
  tagIdsForImagesCache,
  thumbnailCache,
  userBasicCache,
} from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import type { ImageGenerationProcess, MediaType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 100000; // Do not increase - might break Redis from what we've been able to tell.
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = IMAGES_SEARCH_INDEX;

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

  const searchableAttributes: SearchableAttributes = ['prompt', 'tagNames', 'user.username'];

  const sortableAttributes: SortableAttributes = [
    'id',
    'sortAt',
    'stats.commentCountAllTime',
    'stats.reactionCountAllTime',
    'stats.collectedCountAllTime',
    'stats.tippedAmountCountAllTime',
  ];

  const filterableAttributes: FilterableAttributes = [
    'id',
    'createdAtUnix',
    'tagNames',
    'user.username',
    'baseModel',
    'aspectRatio',
    'nsfwLevel',
    'combinedNsfwLevel',
    'type',
    'toolNames',
    'techniqueNames',
    'flags.promptNsfw',
    'poi',
    'minor',
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

type Metrics = {
  id: number;
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
  likeCount: number;
  cryCount: number;
  tippedAmountCount: number;
  heartCount: number;
  laughCount: number;
};

type ModelVersions = {
  id: number;
  baseModel: string[];
  modelVersionIds: number[];
};

type BaseImage = {
  type: MediaType;
  id: number;
  generationProcess: ImageGenerationProcess | null;
  createdAt: Date;
  name: string | null;
  url: string;
  prompt: string;
  hash: string | null;
  height: number | null;
  width: number | null;
  metadata: Prisma.JsonValue;
  nsfwLevel: NsfwLevel;
  aiNsfwLevel: NsfwLevel;
  nsfwLevelLocked: boolean;
  postId: number | null;
  needsReview: string | null;
  hideMeta: boolean;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  userId?: number | null;
  modelVersionId: number | null;
  sortAt?: Date | null;
  promptNsfw?: boolean;
};

const imageWhere = [
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`i."minor" = false`,
  Prisma.sql`i."poi" = false`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
  Prisma.sql`p."availability" != 'Unsearchable'::"Availability"`,
  Prisma.sql`p."publishedAt" <= NOW()`,
];

type ImageTags = Record<number, { tagNames: string[]; tagIds: number[] }>;

const transformData = async ({
  users,
  images,
  imageTags,
  userCosmetics,
  imageCosmetics,
  profilePictures,
  metrics,
  tools,
  techs,
  modelVersions,
  thumbnails,
}: {
  images: BaseImage[];
  imageTags: ImageTags;
  imageCosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
  profilePictures: Awaited<ReturnType<typeof getProfilePicturesForUsers>>;
  users: Awaited<ReturnType<typeof userBasicCache.fetch>>;
  userCosmetics: Awaited<ReturnType<typeof getCosmeticsForUsers>>;
  metrics: Metrics[];
  tools: { imageId: number; tool: string }[];
  techs: { imageId: number; tech: string }[];
  modelVersions: ModelVersions[];
  thumbnails: Awaited<ReturnType<typeof thumbnailCache.fetch>>;
}) => {
  console.log(`transformData :: Transforming data for ${images.length} images`);

  const records = images
    .map(({ userId, id, nsfwLevelLocked, promptNsfw, ...imageRecord }) => {
      const user = userId ? users?.[userId] ?? null : null;

      if (!user || !userId) {
        return null;
      }

      const flags = removeEmpty({
        promptNsfw,
      });

      const userCosmetic = userId ? userCosmetics[userId] ?? null : null;
      const profilePicture = user ? profilePictures[userId] ?? null : null;
      const imageMetrics = metrics.find((m) => m.id === id);
      const toolNames = tools.filter((t) => t.imageId === id).map((t) => t.tool);
      const techniqueNames = techs.filter((t) => t.imageId === id).map((t) => t.tech);
      const baseModel = modelVersions.find((m) => m.id === id)?.baseModel?.find((bm) => !!bm);
      const thumbnail = thumbnails[id] ?? null;

      const nsfwLevel = Math.max(thumbnail?.nsfwLevel ?? 0, imageRecord.nsfwLevel);

      return {
        ...imageRecord,
        id,
        nsfwLevel,
        combinedNsfwLevel: nsfwLevelLocked
          ? nsfwLevel
          : Math.max(nsfwLevel, imageRecord.aiNsfwLevel),
        createdAtUnix: imageRecord.createdAt.getTime(),
        aspectRatio:
          !imageRecord.width || !imageRecord.height
            ? 'Unknown'
            : imageRecord.width > imageRecord.height
            ? 'Landscape'
            : imageRecord.width < imageRecord.height
            ? 'Portrait'
            : 'Square',
        user: {
          ...user,
          cosmetics: userCosmetic ?? [],
          profilePicture,
        },
        tagNames: imageTags[id]?.tagNames ?? [],
        tagIds: imageTags[id]?.tagIds ?? [],
        toolNames,
        techniqueNames,
        baseModel,
        reactions: [],
        thumbnailUrl: thumbnail?.url ?? null,
        cosmetic: imageCosmetics[id] ?? null,
        stats: {
          cryCountAllTime: imageMetrics?.cryCount ?? 0,
          dislikeCountAllTime: 0,
          heartCountAllTime: imageMetrics?.heartCount ?? 0,
          laughCountAllTime: imageMetrics?.laughCount ?? 0,
          likeCountAllTime: imageMetrics?.likeCount ?? 0,
          reactionCountAllTime: imageMetrics?.reactionCount ?? 0,
          commentCountAllTime: imageMetrics?.commentCount ?? 0,
          collectedCountAllTime: imageMetrics?.collectedCount ?? 0,
          tippedAmountCountAllTime: imageMetrics?.tippedAmountCount ?? 0,
        },
        flags: Object.keys(flags).length > 0 ? flags : undefined,
      };
    })
    .filter(isDefined);

  console.log(`transformData :: returning ${records.length} images`);

  return records;
};
export type ImageSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const imagesSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 100, // Avoids hogging too much memory.
  pullSteps: 7,
  prepareBatches: async ({ pg, jobContext }, lastUpdatedAt) => {
    const lastUpdateIso = lastUpdatedAt?.toISOString();

    const newItemsQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`

    SELECT (
      SELECT
      i.id FROM "Image" i
      ${lastUpdatedAt ? `WHERE i."createdAt" >= '${lastUpdateIso}'` : ``}
      ORDER BY "createdAt" LIMIT 1
    ) as "startId", (
      SELECT MAX (id) FROM "Image"
    ) as "endId";
    `);

    jobContext?.on('cancel', newItemsQuery.cancel);
    const newItems = await newItemsQuery.result();
    const { startId, endId } = newItems[0];

    let updateIds: number[] = [];
    // TODO remove createdAt clause below?
    if (lastUpdatedAt) {
      const updatedIdItemsQuery = await pg.cancellableQuery<{ id: number }>(`
        SELECT id
        FROM "Image"
        WHERE "updatedAt" > '${lastUpdateIso}'
          AND "postId" IS NOT NULL
        ORDER BY id;
      `);
      const results = await updatedIdItemsQuery.result();
      updateIds = results.map((x) => x.id);
    }

    // For the time being, we'll keep this index running solely for the purpose
    // of managing deletes / queued updates.
    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
      updateIds: updateIds,
    };
  },
  pullData: async ({ db, logger, indexName }, batch, step, prevData) => {
    const batchLogKey =
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length;

    const where = [
      ...imageWhere,
      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`i.id >= ${batch.startId} AND i.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    logger(`PullData :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

    if (step === 0) {
      const images = await db.$queryRaw<BaseImage[]>`
      SELECT
        i."type",
        i."id",
        i."userId",
        i."generationProcess",
        i."createdAt",
        i."name",
        i."url",
        i."nsfwLevel",
        i."aiNsfwLevel",
        i."nsfwLevelLocked",
        i."meta"->'prompt' as "prompt",
        i."hash",
        i."height",
        i."width",
        i."metadata",
        i."nsfwLevel",
        i."postId",
        i."needsReview",
        i."hideMeta",
        i."index",
        i."scannedAt",
        i."mimeType",
        p."modelVersionId",
        fl."promptNsfw",
        GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId"
        LEFT JOIN "ImageFlag" fl ON i.id = fl."imageId"
        WHERE ${Prisma.join(where, ' AND ')}
      `;

      if (images.length === 0) {
        return null;
      }

      // Also, queue model updates:
      if (batch.type === 'update') {
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

      return {
        images,
      };
    }

    const imageIds = prevData ? (prevData as { images: BaseImage[] }).images.map((i) => i.id) : [];
    const result = prevData as Record<string, any>;
    const batches = chunk(imageIds, 1000);
    let i = 0;
    let noMoreSteps = false;

    for (const batch of batches) {
      i++;
      const subBatchLogKey = `${i} of ${batches.length}`;
      const images = (result.images as BaseImage[]).filter((i) => batch.includes(i.id));

      // Metrics:
      if (step === 1) {
        logger(`Pulling metrics :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        const metrics = await clickhouse?.$query<Metrics>(`
            SELECT entityId as "id",
                   sumIf(total, metricType = 'Collection') as "collectedCount",
                   sumIf(total, metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry')) as "reactionCount",
                   sumIf(total, metricType = 'Comment') as "commentCount",
                   sumIf(total, metricType = 'ReactionLike') as "likeCount",
                   sumIf(total, metricType = 'ReactionCry') as "cryCount",
                   sumIf(total, metricType = 'Buzz') as "tippedAmountCount",
                   sumIf(total, metricType = 'ReactionHeart') as "heartCount",
                   sumIf(total, metricType = 'ReactionLaugh') as "laughCount"
            FROM entityMetricDailyAgg
            WHERE entityType = 'Image'
              AND entityId IN (${batch.join(',')})
            GROUP BY id
          `);

        result.metrics ??= [];
        result.metrics.push(...(metrics ?? []));
        continue;
      }

      // Get modelVersionIds
      if (step === 2) {
        logger(`Pulling modelVersionIds :: ${indexName} ::`, batchLogKey, subBatchLogKey);

        // Model versions & baseModel:
        const modelVersions = await db.$queryRaw<ModelVersions[]>`
        SELECT
          ir."imageId" as id,
          array_agg(COALESCE(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '')) as "baseModel",
          array_agg(mv."id") as "modelVersionIds"
        FROM "ImageResourceNew" ir
        JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
        JOIN "Model" m ON mv."modelId" = m."id"
        WHERE ir."imageId" IN (${Prisma.join(batch)})
        GROUP BY ir."imageId"
      `;

        result.modelVersions ??= [];
        result.modelVersions.push(...(modelVersions ?? []));
        continue;
      }
      // Get tags
      if (step === 3) {
        logger(`Pulling tags :: ${indexName} ::`, batchLogKey, subBatchLogKey);

        const imageTagIds = await tagIdsForImagesCache.fetch(batch);
        const tags = await tagCache.fetch(Object.values(imageTagIds).flatMap((x) => x.tags));

        const imageTags = {} as Record<number, { tagNames: string[]; tagIds: number[] }>;
        for (const [imageId, cache] of Object.entries(imageTagIds)) {
          imageTags[+imageId] = {
            tagNames: cache.tags.map((t) => tags[t]?.name).filter(isDefined),
            tagIds: cache.tags,
          };
        }

        result.imageTags ??= {};
        Object.assign(result.imageTags, imageTags);
        continue;
      }

      // User & Cosmetic Information
      if (step === 4) {
        logger(
          `Pulling User & Cosmetic Information :: ${indexName} ::`,
          batchLogKey,
          subBatchLogKey
        );

        const userIds = [...new Set(images.map((i) => i.userId).filter(isDefined))];
        const users = await userBasicCache.fetch(userIds);
        const profilePictures = await getProfilePicturesForUsers(userIds);
        const cosmetics = await getCosmeticsForEntity({
          ids: imageIds,
          entity: 'Image',
        });
        const userCosmetics = await getCosmeticsForUsers(userIds);

        result.users ??= {};
        Object.assign(result.users, users);

        result.profilePictures ??= {};
        Object.assign(result.profilePictures, profilePictures);

        result.imageCosmetics ??= {};
        Object.assign(result.imageCosmetics, cosmetics);

        result.userCosmetics ??= {};
        Object.assign(result.userCosmetics, userCosmetics);

        continue;
      }

      // Get tools & techs
      if (step === 5) {
        logger(`Pulling tools & techs :: ${indexName} ::`, batchLogKey, subBatchLogKey);

        const tools = await dbRead.$queryRaw<{ imageId: number; tool: string }[]>`
          SELECT
            it."imageId",
            t."name" as tool
          FROM "ImageTool" it
          JOIN "Tool" t ON it."toolId" = t."id"
          WHERE it."imageId" IN  (${Prisma.join(batch)})
        `;

        result.tools ??= [];
        result.tools.push(...tools);

        const techs = await dbRead.$queryRaw<{ imageId: number; tech: string }[]>`
          SELECT
            it."imageId",
            t."name" as tech
          FROM "ImageTechnique" it
          JOIN "Technique" t ON it."techniqueId" = t."id"
          WHERE it."imageId" IN  (${Prisma.join(batch)})
        `;

        result.techs ??= [];
        result.techs.push(...techs);
        continue;
      }

      // Get thumbnails
      if (step === 6) {
        logger(`Pulling thumbnails :: ${indexName} ::`, batchLogKey, subBatchLogKey);

        const thumbnails = await thumbnailCache.fetch(batch);

        result.thumbnails ??= {};
        Object.assign(result.thumbnails, thumbnails);
        continue;
      }

      noMoreSteps = true;
    }

    if (noMoreSteps) return null;
    return result;
  },
  transformData,
  pushData: async ({ indexName }, data) => {
    console.log(`PushData :: ${indexName} :: Pushing data for ${data.length} images`);
    if (data.length > 0) {
      await updateDocs({
        indexName,
        documents: data,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      });
    }

    return;
  },
});
