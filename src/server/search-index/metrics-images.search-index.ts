import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 100000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

const searchableAttributes = [] as const;

const sortableAttributes = ['sortAt', 'reactionCount', 'commentCount', 'collectedCount'] as const;

const filterableAttributes = [
  'id',
  'sortAtUnix',
  'modelVersionIds',
  'postedToId',
  'baseModel',
  'type',
  'hasMeta',
  'onSite',
  'toolIds',
  'techniqueIds',
  'tagIds',
  'userId',
  'nsfwLevel',
  'postId',
  'published',
] as const;

export type MetricsImageSearchableAttribute = (typeof searchableAttributes)[number];
export type MetricsImageSortableAttribute = (typeof sortableAttributes)[number];
export type MetricsImageFilterableAttribute = (typeof filterableAttributes)[number];

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' }, client);
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributesSorted = searchableAttributes.toSorted();
  const sortableAttributesSorted = sortableAttributes.toSorted();
  const filterableAttributesSorted = filterableAttributes.toSorted();

  if (
    JSON.stringify(searchableAttributesSorted) !== JSON.stringify(settings.searchableAttributes)
  ) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributesSorted
    );

    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  if (JSON.stringify(sortableAttributesSorted) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(
      sortableAttributesSorted
    );

    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  if (
    JSON.stringify(filterableAttributesSorted) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributesSorted
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

export type SearchBaseImage = {
  id: number;
  index: number;
  postId: number;
  url: string;
  nsfwLevel: number;
  width: number;
  height: number;
  hash: string;
  hideMeta: boolean;
  sortAt: Date;
  type: string;
  userId: number;
  published: boolean;
  hasMeta: boolean;
  onSite: boolean;
  postedToId?: number;
  needsReview: string | null;
};

type Metrics = {
  id: number;
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
};

type ModelVersions = {
  id: number;
  baseModel: string;
  modelVersionIds: number[];
};

type ImageTool = {
  imageId: number;
  toolId: number;
};

type ImageTechnique = {
  imageId: number;
  techniqueId: number;
};

type ImageCosmetics = Awaited<ReturnType<typeof getCosmeticsForEntity>>;
type ImageTags = Awaited<ReturnType<typeof tagIdsForImagesCache.fetch>>;

export type ImageForMetricSearchIndex = {
  sortAtUnix: number;
  tagIds: number[];
  toolIds: number[];
  techniqueIds: number[];
} & SearchBaseImage &
  Metrics &
  ModelVersions;

const transformData = async ({
  images,
  imageTags,
  metrics,
  tools,
  techniques,
  cosmetics,
  modelVersions,
}: {
  images: SearchBaseImage[];
  imageTags: ImageTags;
  metrics: Metrics[];
  tools: ImageTool[];
  techniques: ImageTechnique[];
  cosmetics: ImageCosmetics;
  modelVersions: ModelVersions[];
}) => {
  const records = images
    .map((imageRecord) => {
      const imageTools = tools.filter((t) => t.imageId === imageRecord.id);
      const imageTechniques = techniques.filter((t) => t.imageId === imageRecord.id);

      const { modelVersionIds, baseModel } = modelVersions.find(
        (mv) => mv.id === imageRecord.id
      ) || { modelVersionIds: [], baseModel: '' };

      const imageMetrics = metrics.find((m) => m.id === imageRecord.id) ?? {
        id: imageRecord.id,
        reactionCount: 0,
        commentCount: 0,
        collectedCount: 0,
      };

      return {
        ...imageRecord,
        ...imageMetrics,
        baseModel,
        modelVersionIds,
        toolIds: imageTools.map((t) => t.toolId),
        techniqueIds: imageTechniques.map((t) => t.techniqueId),
        cosmetic: cosmetics[imageRecord.id] ?? null,
        sortAtUnix: imageRecord.sortAt.getTime(),
        nsfwLevel: imageRecord.nsfwLevel,
        tagIds: imageTags[imageRecord.id]?.tags ?? [],
      };
    })
    .filter(isDefined);

  return records;
};

export type ImageMetricsSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const imagesMetricsDetailsSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 100, // Avoids hogging too much memory.
  pullSteps: 6,
  prepareBatches: async ({ db, pg, jobContext }, lastUpdatedAt) => {
    const newItemsQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (
        SELECT
          i.id FROM "Image" i
        WHERE i."postId" IS NOT NULL
        ${lastUpdatedAt ? ` AND i."createdAt" >= '${lastUpdatedAt}'` : ``}
        ORDER BY "createdAt" LIMIT 1
      ) as "startId", (
        SELECT MAX (id) FROM "Image" i
        WHERE i."postId" IS NOT NULL
      ) as "endId";
    `);

    jobContext.on('cancel', newItemsQuery.cancel);
    const newItems = await newItemsQuery.result();
    const { startId, endId } = newItems[0];
    const updateIds: number[] = [];

    if (lastUpdatedAt) {
      let lastId = 0;

      while (true) {
        const updatedIdItemsQuery = await pg.cancellableQuery<{ id: number }>(`
          SELECT id
          FROM "Image"
          WHERE "updatedAt" > '${lastUpdatedAt}'
            AND "postId" IS NOT NULL
            AND id > ${lastId}
          ORDER BY id
          LIMIT ${READ_BATCH_SIZE};
        `);

        jobContext.on('cancel', updatedIdItemsQuery.cancel);
        const ids = await updatedIdItemsQuery.result();

        if (!ids.length) {
          break;
        }

        lastId = ids[ids.length - 1].id;
        updateIds.push(...ids.map((x) => x.id));
      }
    }

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
      updateIds,
    };
  },
  pullData: async ({ db, logger, indexName }, batch, step, prevData) => {
    const where = [
      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.raw(`i.id BETWEEN ${batch.startId} AND ${batch.endId}`)
        : undefined,
    ].filter(isDefined);
    logger(
      `PullData :: Pulling data for batch`,
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
    );

    if (step === 0) {
      const images = await db.$queryRaw<SearchBaseImage[]>`
      SELECT
        i."id",
        i."index",
        i."postId",
        i."url",
        i."nsfwLevel",
        i."width",
        i."height",
        i."hash",
        i."hideMeta",
        i."sortAt",
        i."type",
        i."userId",
        i."needsReview",
        p."publishedAt" is not null as "published",
        (
          CASE
            WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            THEN TRUE
            ELSE FALSE
          END
        ) AS "hasMeta",
        (
          CASE
            WHEN i.meta->>'civitaiResources' IS NOT NULL
            THEN TRUE
            ELSE FALSE
          END
        ) as "onSite",
        p."modelVersionId" as "postedToId"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId"
        WHERE ${Prisma.join(where, ' AND ')}
      `;

      if (images.length === 0) {
        return null;
      }

      return {
        images,
      };
    }

    const imageIds = prevData
      ? (prevData as { images: SearchBaseImage[] }).images.map((i) => i.id)
      : [];
    const result = prevData as Record<string, any>;
    const batches = chunk(imageIds, 1000);
    let noMoreSteps = false;
    for (const batch of batches) {
      if (step === 1) {
        // Pull metrics:
        // TODO: Use clickhouse to pull metrics.

        const metrics = await db.$queryRaw<Metrics[]>`
            SELECT
              im."imageId" as id,
              im."collectedCount" as "collectedCount",
              im."reactionCount" as "reactionCount",
              im."commentCount" as "commentCount"
            FROM "ImageMetric" im
            WHERE im."imageId" IN (${Prisma.join(batch)})
              AND im."timeframe" = 'AllTime'::"MetricTimeframe"
        `;

        result.metrics ??= [];
        result.metrics.push(...metrics);
        continue;
      }

      if (step === 2) {
        // Pull tags:
        const cacheImageTags = await tagIdsForImagesCache.fetch(batch);

        result.imageTags ??= {};
        Object.assign(result.imageTags, cacheImageTags);
        continue;
      }

      if (step === 3) {
        // Tools and techniqaues

        const tools: ImageTool[] = await db.imageTool.findMany({
          select: {
            imageId: true,
            toolId: true,
          },
          where: { imageId: { in: batch } },
        });

        result.tools ??= [];
        result.tools.push(...tools);

        const techniques: ImageTechnique[] = await db.imageTechnique.findMany({
          where: { imageId: { in: batch } },
          select: {
            imageId: true,
            techniqueId: true,
          },
        });
        result.techniques ??= [];
        result.techniques.push(...techniques);
        continue;
      }

      if (step === 4) {
        // Cosmetics:

        const cosmetics = await getCosmeticsForEntity({
          ids: batch,
          entity: 'Image',
        });

        result.cosmetics ??= {};
        Object.assign(result.cosmetics, cosmetics);
        continue;
      }

      if (step === 5) {
        // Model versions & baseModel:

        const modelVersions = await db.$queryRaw<ModelVersions[]>`
          SELECT
            ir."imageId" as id,
            string_agg(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '') as "baseModel",
            array_agg(mv."id") as "modelVersionIds"
          FROM "ImageResource" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
          JOIN "Model" m ON mv."modelId" = m."id"
          WHERE ir."imageId" IN (${Prisma.join(batch)})
          GROUP BY ir."imageId", mv."baseModel"
        `;

        result.modelVersions ??= [];
        result.modelVersions.push(...modelVersions);
        continue;
      }

      noMoreSteps = true;
    }

    if (noMoreSteps) return null;
    return result;
  },
  transformData,
  pushData: async ({ indexName }, data) => {
    if (data.length > 0) {
      await updateDocs({
        indexName,
        documents: data,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
        client,
      });
    }

    return;
  },
  client,
});
