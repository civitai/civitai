import { ImageGenerationProcess, ImageIngestionStatus, MediaType, Prisma } from '@prisma/client';
import { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { pgDbRead } from '~/server/db/pgDb';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { tagCache, tagIdsForImagesCache, userBasicCache } from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 1000; // Do not increase - might break Redis from what we've been able to tell.
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
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
    'sortAt',
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
    'aspectRatio',
    'nsfwLevel',
    'combinedNsfwLevel',
    'type',
    'toolNames',
    'techniqueNames',
    'flags.promptNsfw',
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
}) => {
  const records = images
    .map(({ userId, id, nsfwLevelLocked, promptNsfw, ...imageRecord }) => {
      const user = userId ? users[userId] ?? null : null;

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

      return {
        ...imageRecord,
        id,
        nsfwLevel: imageRecord.nsfwLevel,
        combinedNsfwLevel: nsfwLevelLocked
          ? imageRecord.nsfwLevel
          : Math.max(imageRecord.nsfwLevel, imageRecord.aiNsfwLevel),
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

  return records;
};
export type ImageSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const imagesSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  pullSteps: 6,
  prepareBatches: async ({ db }, lastUpdatedAt) => {
    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
    SELECT (
      SELECT
      i.id FROM "Image" i
      ${
        lastUpdatedAt
          ? Prisma.sql`
        WHERE i."createdAt" >= ${lastUpdatedAt}
      `
          : Prisma.sql``
      }
      ORDER BY "createdAt" LIMIT 1
    ) as "startId", (
      SELECT MAX (id) FROM "Image"
    ) as "endId";
    `;

    const { startId, endId } = data[0];

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
    };
  },
  pullData: async ({ db, logger }, batch, step, prevData) => {
    logger(
      `PullData :: Pulling data for batch`,
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
    );
    const where = [
      ...imageWhere,

      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`i.id >= ${batch.startId} AND i.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

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
        COALESCE(p."publishedAt", i."createdAt") as "sortAt"
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

    // Get metrics
    if (step === 1) {
      // TODO: Use clickhouse to pull metrics.
      const { images } = prevData as { images: BaseImage[] };

      const metrics = await db.$queryRaw`
          SELECT
            im."imageId" as id,
            im."collectedCount" as "collectedCount",
            im."reactionCount" as "reactionCount",
            im."commentCount" as "commentCount",
            im."likeCount" as "likeCount",
            im."cryCount" as "cryCount",
            im."laughCount" as "laughCount",
            im."tippedAmountCount" as "tippedAmountCount",
            im."heartCount" as "heartCount"
          FROM "ImageMetric" im
          WHERE im."imageId" IN (${Prisma.join(images.map((i) => i.id))})
            AND im."timeframe" = 'AllTime'::"MetricTimeframe"
      `;

      return {
        ...prevData,
        images,
        metrics,
      };
    }

    // Get modelVersionIds
    if (step === 2) {
      // Model versions & baseModel:
      const { images, ...other } = prevData as {
        images: BaseImage[];
      };

      const { rows: modelVersions } = await pgDbRead.query<ModelVersions>(`
        SELECT
          ir."imageId" as id,
          array_agg(COALESCE(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '')) as "baseModel",
          array_agg(mv."id") as "modelVersionIds"
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
        JOIN "Model" m ON mv."modelId" = m."id"
        WHERE ir."imageId" IN (${images.map((i) => i.id).join(',')})
        GROUP BY ir."imageId"
      `);

      return {
        ...prevData,
        images,
        modelVersions,
      };
    }

    // Get tags
    if (step === 3) {
      const { images } = prevData as { images: BaseImage[] };

      const imageIds = images.map((i) => i.id);
      const imageTagIds = await tagIdsForImagesCache.fetch(imageIds);
      const tags = await tagCache.fetch(Object.values(imageTagIds).flatMap((x) => x.tags));

      const imageTags = {} as Record<number, { tagNames: string[]; tagIds: number[] }>;
      for (const [imageId, cache] of Object.entries(imageTagIds)) {
        imageTags[+imageId] = {
          tagNames: cache.tags.map((t) => tags[t]?.name).filter(isDefined),
          tagIds: cache.tags,
        };
      }

      return {
        ...prevData,
        images,
        imageTags,
      };
    }

    // User & Cosmetic Information
    if (step === 4) {
      const { images } = prevData as {
        images: BaseImage[];
      };

      const imageIds = images.map((i) => i.id);
      const userIds = [...new Set(images.map((i) => i.userId).filter(isDefined))];
      const users = await userBasicCache.fetch(userIds);
      const profilePictures = await getProfilePicturesForUsers(userIds);
      const cosmetics = await getCosmeticsForEntity({
        ids: imageIds,
        entity: 'Image',
      });
      const userCosmetics = await getCosmeticsForUsers(userIds);

      return {
        ...prevData,
        profilePictures,
        imageCosmetics: cosmetics,
        userCosmetics,
        users,
      };
    }

    // Get tools & techs
    if (step === 5) {
      const { images } = prevData as {
        images: BaseImage[];
      };

      const imageIds = images.map((i) => i.id);
      const tools = await dbRead.$queryRaw<{ imageId: number; tool: string }[]>`
        SELECT
          it."imageId",
          t."name" as tool
        FROM "ImageTool" it
        JOIN "Tool" t ON it."toolId" = t."id"
        WHERE it."imageId" IN (${Prisma.join(imageIds)})
      `;

      const techs = await dbRead.$queryRaw<{ imageId: number; tech: string }[]>`
        SELECT
          it."imageId",
          t."name" as tech
        FROM "ImageTechnique" it
        JOIN "Technique" t ON it."techniqueId" = t."id"
        WHERE it."imageId" IN (${Prisma.join(imageIds)})
      `;

      return {
        ...prevData,
        images,
        tools,
        techs,
      };
    }

    return prevData;
  },
  transformData,
  pushData: async ({ indexName }, data) => {
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
