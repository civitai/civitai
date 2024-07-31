import { ImageTag, Prisma } from '@prisma/client';
import { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;
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

  const searchableAttributes: SearchableAttributes = ['prompt'];

  const sortableAttributes: SortableAttributes = [
    'sortAt',
    'reactionCount',
    'commentCount',
    'collectedCount',
  ];

  const filterableAttributes: FilterableAttributes = [
    'sortAtUnix',
    'modelVersionIds',
    'postedToId',
    'baseModel',
    'type',
    'hasMeta',
    'onSite',
    'toolsIds',
    'techniqueIds',
    'tagIds',
    'userId',
    'nsfwLevel',
    'postId',
    'published',
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

export type SearchBaseImage = {
  id: number;
  index: number;
  postId: number;
  url: string;
  nsfwLevel: number;
  prompt: string;
  sortAt: Date;
  type: string;
  width: number;
  height: number;
  userId: number;
  published: boolean;
  hasMeta: boolean;
  onSite: boolean;
  postedToId?: number;
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
  tool: {
    name: string;
  };
};

type ImageTechnique = {
  imageId: number;
  technique: {
    name: string;
  };
};

type ImageCosmetics = Awaited<ReturnType<typeof getCosmeticsForEntity>>;
type ImageTags = Awaited<ReturnType<typeof tagIdsForImagesCache.fetch>>;

export type ImageForMetricSearchIndex = {
  sortAtUnix: number;
  tags: string[];
  tools: string[];
  techniques: string[];
} & SearchBaseImage &
  Metrics &
  ModelVersions;

const transformData = async ({
  images,
  tags,
  metrics,
  tools,
  techniques,
  cosmetics,
  modelVersions,
}: {
  images: SearchBaseImage[];
  tags: ImageTags;
  metrics: Metrics[];
  tools: ImageTool[];
  techniques: ImageTechnique[];
  cosmetics: ImageCosmetics;
  modelVersions: ModelVersions[];
}) => {
  const records = images
    .map((imageRecord) => {
      const imageTools = tools.filter((t) => t.imageId === imageRecord.id).map((t) => t.tool.name);
      const imageTechniques = techniques
        .filter((t) => t.imageId === imageRecord.id)
        .map((t) => t.technique.name);

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
        tools: imageTools,
        techniques: imageTechniques,
        cosmetic: cosmetics[imageRecord.id] ?? null,
        sortAtUnix: imageRecord.sortAt.getTime(),
        nsfwLevel: imageRecord.nsfwLevel,
        tags: (tags[imageRecord.id] ?? { tags: [], imageId: -1 }).tags,
      };
    })
    .filter(isDefined);

  return records;
};

export type ImageMetricsSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

// TODO.imageMetrics create another index updater for specifically updating metrics
export const imagesMetricsDetailsSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 15,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  pullSteps: 6,
  prepareBatches: async ({ db, pg, jobContext }, lastUpdatedAt) => {
    // TODO.imageMetrics set updatedAt on image when post is published
    const newItemsQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (	
        SELECT
          i.id FROM "Image" i
        WHERE i."postId" IS NOT NULL 
        ${lastUpdatedAt ? ` AND i."createdAt" >= ${lastUpdatedAt}` : ``}
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
      let offset = 0;

      while (true) {
        const updatedIdItemsQuery = await pg.cancellableQuery<{ id: number }>(`
        FROM "Image"
        WHERE "updatedAt" > ${lastUpdatedAt}
          AND i."postId" IS NOT NULL
        OFFSET ${offset} LIMIT ${READ_BATCH_SIZE};
        `);

        jobContext.on('cancel', updatedIdItemsQuery.cancel);
        const ids = await updatedIdItemsQuery.result();

        if (!ids.length) {
          break;
        }

        offset += READ_BATCH_SIZE;
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
    const isReset = indexName.includes('_NEW');
    const where = [
      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`i.id BETWEEN ${batch.startId} AND ${batch.endId}`
        : undefined,
    ];

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
        i."meta"->'prompt' as "prompt",
        i."hideMeta",
        i."sortAt",
        i."type",
        i."userId",
        p."publishedAt" is not null as "published",
        (
          CASE
            WHEN i.meta IS NOT NULL AND NOT i."hideMeta"
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

    if (step === 1) {
      // Pull metrics:
      // TODO: Use clickhouse to pull metrics.
      const { images } = prevData as { images: SearchBaseImage[] };

      const metrics = await db.$queryRaw`
          SELECT
            im."imageId" as id,
            im."collectedCount" as "collectedCount",
            im."reactionCount" as "reactionCount",
            im."commentCount" as "commentCount"
          FROM "ImageMetric" im
          WHERE im."imageId" IN (${Prisma.join(images.map((i) => i.id))})
            AND im."timeframe" = 'AllTime'::"MetricTimeframe"
      `;

      return {
        images,
        metrics,
      };
    }

    if (step === 2) {
      // Pull tags:
      const { images, metrics } = prevData as { images: SearchBaseImage[]; metrics: Metrics[] };

      let tags: ImageTags;

      // TODO.imageMetrics - use cache if not reseting
      if (isReset) {
        const rawTags = await db.$queryRaw<{ imageId: number; tagId: number; tagName: string }[]>`
        SELECT
          "imageId",
          "tagId",
          t."name" as "tagName"
        FROM "tagsOnImage"
        JOIN "Tag" t ON "tagId" = t."id"
        WHERE "imageId" IN (${Prisma.join(images.map((i) => i.id))})
      `;

        tags = rawTags.reduce((acc, { imageId, tagId, tagName }) => {
          if (!acc[imageId.toString()]) {
            acc[imageId.toString()] = {
              imageId,
              tags: [],
            };
          }
          acc[imageId].tags.push({ id: tagId, name: tagName });
          return acc;
        }, {} as ImageTags);
      } else {
        tags = await tagIdsForImagesCache.fetch(images.map((i) => i.id));
      }

      return {
        images,
        tags,
        metrics,
      };
    }

    if (step === 3) {
      // Tools and techniqaues
      const { images, ...other } = prevData as {
        images: SearchBaseImage[];
        tags: ImageTags;
        metrics: Metrics[];
      };

      const tools = await db.imageTool.findMany({
        select: {
          imageId: true,
          tool: {
            select: {
              name: true,
            },
          },
        },
        where: { imageId: { in: images.map((i) => i.id) } },
      });

      const techniques = await db.imageTechnique.findMany({
        where: { imageId: { in: images.map((i) => i.id) } },
        select: {
          imageId: true,
          technique: {
            select: {
              name: true,
            },
          },
        },
      });

      return {
        ...other,
        images,
        tools,
        techniques,
      };
    }

    if (step === 4) {
      // Cosmetics:
      const { images, ...other } = prevData as {
        images: SearchBaseImage[];
        tags: ImageTags;
        metrics: Metrics[];
        tools: ImageTool[];
        techniques: ImageTechnique[];
      };

      const cosmetics = await getCosmeticsForEntity({
        ids: images.map((i) => i.id),
        entity: 'Image',
      });

      return {
        ...other,
        images,
        cosmetics,
      };
    }

    if (step === 5) {
      // Model versions & baseModel:
      const { images, ...other } = prevData as {
        images: SearchBaseImage[];
        tags: ImageTags;
        metrics: Metrics[];
        tools: ImageTool[];
        techniques: ImageTechnique[];
        cosmetics: ImageCosmetics;
      };

      const modelVersions = await db.$queryRaw<ModelVersions[]>`
      SELECT
        ir."imageId" as id,
        string_agg(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '') as "baseModel",
        array_agg(mv."id") as "modelVersionIds"
      FROM "ImageResource" ir
      JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
      JOIN "Model" m ON mv."modelId" = m."id"
      WHERE ir."imageId" IN (${Prisma.join(images.map((i) => i.id))})
      GROUP BY ir."imageId", mv."baseModel"

      `;

      return {
        ...other,
        images,
        modelVersions,
      };
    }

    return null;
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
