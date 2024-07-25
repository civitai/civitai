import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { FilterableAttributes, SearchableAttributes, SortableAttributes } from 'meilisearch';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { ImageIngestionStatus, ImageTag, Prisma } from '@prisma/client';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

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
    'baseModel',
    'mediaType',
    'hasMeta',
    'madeOnSite',
    'tools',
    'techniques',
    'tags',
    'userId',
    'nsfwevel',
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

type BaseImage = {
  id: number;
  userId: number;
  prompt: string;
  url: string;
  postId: number;
  mediaType: string;
  hasMeta: boolean;
  madeOnSite: boolean;
  sortAt: Date;
  nsfwLevel: number;
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

export type ImageForMetricSearchIndex = {
  sortAtUnix: number;
  tags: string[];
  tools: string[];
  techniques: string[];
} & BaseImage &
  Metrics &
  ModelVersions;

// This where is what we currently show in the feed - May need to be updated, but should cover the overall use case.
const imageWhere = [
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."type" = 'image'`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
  Prisma.sql`p."availability" != 'Unsearchable'::"Availability"`,
];

const transformData = async ({
  images,
  rawTags,
  metrics,
  tools,
  techniques,
  cosmetics,
  modelVersions,
}: {
  images: BaseImage[];
  rawTags: ImageTag[];
  metrics: Metrics[];
  tools: ImageTool[];
  techniques: ImageTechnique[];
  cosmetics: ImageCosmetics;
  modelVersions: ModelVersions[];
}) => {
  console.log(rawTags, tools, techniques, modelVersions);
  const records = images
    .map(({ userId, ...imageRecord }) => {
      const tags = rawTags
        .filter((rt) => rt.imageId === imageRecord.id)
        .map((rt) => ({ id: rt.tagId, name: rt.tagName }));

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
        nsfwLevel: parseBitwiseBrowsingLevel(imageRecord.nsfwLevel),
        tags: tags.map((t) => t.name),
      };
    })
    .filter(isDefined);

  return records;
};

export type ImageMetricsSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const imagesMetricsSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 15,
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
    logger(`PullData :: Pulling data for batch: ${batch}`);
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
        i."type" as "mediaType",
        i."userId", 
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
        ) as "madeOnSite"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY i."id"
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
      const { images } = prevData as { images: BaseImage[] };

      const metrics = await db.$queryRaw`
          SELECT
            im."imageId" as id,
            im."collectedCount" as "collectedCount",
            im."reactionCount" as "reactionCount",
            im."commentCount" as "commentCount"
          FROM "ImageMetric" im
          WHERE im."imageId" IN (${Prisma.join(images.map(({ id }) => id))})
            AND im."timeframe" = 'AllTime'::"MetricTimeframe"
    `;

      return {
        images,
        metrics,
      };
    }

    if (step === 2) {
      // Pull tags:
      const { images, metrics } = prevData as { images: BaseImage[]; metrics: Metrics[] };

      const rawTags = await db.imageTag.findMany({
        where: { imageId: { in: images.map((i) => i.id) }, concrete: true },
        select: {
          imageId: true,
          tagId: true,
          tagName: true,
        },
      });

      return {
        images,
        rawTags,
        metrics,
      };
    }

    if (step === 3) {
      // Tools and techniqaues
      const { images, ...other } = prevData as {
        images: BaseImage[];
        rawTags: ImageTag[];
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
        images: BaseImage[];
        rawTags: ImageTag[];
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
        images: BaseImage[];
        rawTags: ImageTag[];
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
