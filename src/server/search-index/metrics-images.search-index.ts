import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import type { BlockedReason } from '~/server/common/enums';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import type { Availability } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';

const READ_BATCH_SIZE = 100000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = METRICS_IMAGES_SEARCH_INDEX;

const searchableAttributes = [] as const;

const sortableAttributes = [
  'id',
  'sortAt',
  'reactionCount',
  'commentCount',
  'collectedCount',
] as const;

const rankingRules = ['sort'];

const filterableAttributes = [
  'id',
  'sortAtUnix',
  'modelVersionIds', // auto-detected going forward, auto + postedTo historically
  'modelVersionIdsManual',
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
  'combinedNsfwLevel',
  'postId',
  'publishedAtUnix',
  'existedAtUnix',
  'flags.promptNsfw',
  'remixOfId',
  'availability',
  'poi',
  'minor',
  'blockedFor',
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

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
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
  aiNsfwLevel: number;
  nsfwLevelLocked: boolean;
  width: number;
  height: number;
  hash: string;
  hideMeta: boolean;
  sortAt: Date;
  type: string;
  userId: number;
  publishedAt?: Date;
  hasMeta: boolean;
  onSite: boolean;
  postedToId?: number;
  needsReview: string | null;
  minor?: boolean;
  promptNsfw?: boolean;
  blockedFor: BlockedReason | null;
  remixOfId?: number | null;
  hasPositivePrompt?: boolean;
  availability?: Availability;
  poi: boolean;
  acceptableMinor?: boolean;
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
  modelVersionIdsAuto: number[];
  modelVersionIdsManual: number[];
  poi: boolean;
};

type ImageTool = {
  imageId: number;
  toolId: number;
};

type ImageTechnique = {
  imageId: number;
  techniqueId: number;
};

type ImageTags = Awaited<ReturnType<typeof tagIdsForImagesCache.fetch>>;

const transformData = async ({
  images,
  imageTags,
  metrics,
  tools,
  techniques,
  modelVersions,
}: {
  images: SearchBaseImage[];
  imageTags: ImageTags;
  metrics: Metrics[];
  tools: ImageTool[];
  techniques: ImageTechnique[];
  modelVersions: ModelVersions[];
}) => {
  const records = images
    .map(({ publishedAt, nsfwLevelLocked, promptNsfw, ...imageRecord }) => {
      const imageTools = tools.filter((t) => t.imageId === imageRecord.id);
      const imageTechniques = techniques.filter((t) => t.imageId === imageRecord.id);

      const {
        modelVersionIdsAuto,
        modelVersionIdsManual,
        baseModel,
        poi: resourcePoi,
      } = modelVersions.find((mv) => mv.id === imageRecord.id) || {
        modelVersionIdsAuto: [] as number[],
        modelVersionIdsManual: [] as number[],
        baseModel: '',
        poi: false,
      };

      const imageMetrics = metrics.find((m) => m.id === imageRecord.id) ?? {
        id: imageRecord.id,
        reactionCount: 0,
        commentCount: 0,
        collectedCount: 0,
      };

      const flags = removeEmpty({
        promptNsfw,
      });

      return {
        ...imageRecord,
        ...imageMetrics,
        // Best way we currently have to detect current POI of processed images.
        poi: imageRecord.poi ?? resourcePoi,
        combinedNsfwLevel: nsfwLevelLocked
          ? imageRecord.nsfwLevel
          : Math.max(imageRecord.nsfwLevel, imageRecord.aiNsfwLevel),
        baseModel,
        modelVersionIds: modelVersionIdsAuto,
        modelVersionIdsManual,
        toolIds: imageTools.map((t) => t.toolId),
        techniqueIds: imageTechniques.map((t) => t.techniqueId),
        publishedAtUnix: publishedAt?.getTime(),
        existedAtUnix: new Date().getTime(),
        sortAtUnix: imageRecord.sortAt.getTime(),
        nsfwLevel: imageRecord.nsfwLevel,
        tagIds: imageTags[imageRecord.id]?.tags ?? [],
        flags: Object.keys(flags).length > 0 ? flags : undefined,
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
  pullSteps: 5,
  prepareBatches: async ({ db, pg, jobContext }, lastUpdatedAt) => {
    const lastUpdateIso = lastUpdatedAt?.toISOString();
    const newItemsQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (
        SELECT
          i.id FROM "Image" i
        WHERE i."postId" IS NOT NULL
        ${lastUpdatedAt ? ` AND i."createdAt" >= '${lastUpdateIso}'` : ``}
        ORDER BY "createdAt" LIMIT 1
      ) as "startId", (
        SELECT MAX (id) FROM "Image" i
        WHERE i."postId" IS NOT NULL
      ) as "endId";
    `);

    jobContext?.on('cancel', newItemsQuery.cancel);
    const newItems = await newItemsQuery.result();
    const { startId, endId } = newItems[0];

    let updateIds: number[] = [];
    if (lastUpdatedAt) {
      const updateStartIso = new Date().toISOString();
      const updatedIdItemsQuery = await pg.cancellableQuery<{ id: number; postId?: number }>(`
        WITH updated as (
          SELECT id
          FROM "Image"
          WHERE "updatedAt" >= '${lastUpdateIso}'
          AND "updatedAt" < '${updateStartIso}'
          AND id < ${startId} -- Since we're already pulling these..
        )
        SELECT
          id,
          (SELECT "postId" FROM "Image" i WHERE i.id = u.id) as "postId"
        FROM updated u;
      `);
      const results = await updatedIdItemsQuery.result();
      updateIds = results.filter((x) => x.postId).map((x) => x.id);
    }

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
      updateIds,
    };
  },
  pullData: async ({ db, logger, indexName }, batch, step, prevData) => {
    const batchLogKey =
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length;
    const where = [
      batch.type === 'update' ? Prisma.sql`i.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.raw(`i.id BETWEEN ${batch.startId} AND ${batch.endId}`)
        : undefined,
    ].filter(isDefined);
    logger(`PullData :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

    if (step === 0) {
      const engines = Object.keys(videoGenerationConfig2);

      const images = await db.$queryRaw<SearchBaseImage[]>`
      SELECT
        i."id",
        i."index",
        i."postId",
        i."url",
        i."nsfwLevel",
        i."aiNsfwLevel",
        i."nsfwLevelLocked",
        i."width",
        i."height",
        i."hash",
        i."hideMeta",
        GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
        i."type",
        i."userId",
        i."needsReview",
        i."blockedFor",
        i.minor,
        i.poi,
        i."acceptableMinor",
        p."publishedAt",
        p."availability",
        (
          CASE
            WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
            THEN TRUE
            ELSE FALSE
          END
        ) AS "hasMeta",
        (
          CASE
            WHEN i.meta IS NOT NULL AND jsonb_typeof(i.meta) != 'null' AND NOT i."hideMeta"
              AND i.meta->>'prompt' IS NOT NULL
            THEN TRUE
            ELSE FALSE
          END
        ) AS "hasPositivePrompt",
        (
          CASE
            WHEN (i.meta->>'civitaiResources' IS NOT NULL AND NOT (i.meta ? 'Version'))
              OR i.meta->>'workflow' IS NOT NULL AND i.meta->>'engine' = ANY(ARRAY[
                ${Prisma.join(engines)}
              ]::text[])
            THEN TRUE
            ELSE FALSE
          END
        ) as "onSite",
        p."modelVersionId" as "postedToId",
        i."meta"->'extra'->'remixOfId' as "remixOfId"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId"
        WHERE ${Prisma.join(where, ' AND ')}
      `;
      logger(`PullData Complete :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

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
    let i = 0;
    let noMoreSteps = false;

    for (const batch of batches) {
      i++;
      const subBatchLogKey = `${i} of ${batches.length}`;

      if (step === 1) {
        logger(`Pulling metrics :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        const metrics = await clickhouse?.$query<Metrics>(`
            SELECT entityId as "id",
                   sumIf(total, metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry')) as "reactionCount",
                   sumIf(total, metricType = 'Comment') as "commentCount",
                   sumIf(total, metricType = 'Collection') as "collectedCount"
            FROM entityMetricDailyAgg
            WHERE entityType = 'Image'
              AND entityId IN (${batch.join(',')})
            GROUP BY id
          `);

        result.metrics ??= [];
        result.metrics.push(...(metrics ?? []));
        continue;
      }

      if (step === 2) {
        logger(`Pulling tags :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Pull tags:
        const cacheImageTags = await tagIdsForImagesCache.fetch(batch);

        result.imageTags ??= {};
        Object.assign(result.imageTags, cacheImageTags);
        continue;
      }

      if (step === 3) {
        logger(`Pulling techs and tools :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Tools and techs

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
        logger(`Pulling versions :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Model versions & baseModel:

        const modelVersions = await db.$queryRaw<ModelVersions[]>`
          SELECT
            ir."imageId" as id,
            string_agg(CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel" ELSE NULL END, '') as "baseModel",
            coalesce(array_agg(mv."id") FILTER (WHERE ir.detected is true), '{}') as "modelVersionIdsAuto",
            coalesce(array_agg(mv."id") FILTER (WHERE ir.detected is not true), '{}') as "modelVersionIdsManual",
            SUM(IIF(m.poi, 1, 0)) > 0 "poi"
          FROM "ImageResourceNew" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv."id"
          JOIN "Model" m ON mv."modelId" = m."id"
          WHERE ir."imageId" IN (${Prisma.join(batch)})
          GROUP BY ir."imageId";
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
