import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { METRICS_MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { modelTagCache } from '~/server/redis/caches';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import type {
  Availability,
  ModelStatus,
  ModelType,
  CheckpointType,
} from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';

const READ_BATCH_SIZE = 100000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = METRICS_MODELS_SEARCH_INDEX;

const searchableAttributes = [] as const;

const sortableAttributes = [
  'id',
  'publishedAt',
  'lastVersionAt',
  'downloadCount',
  'favoriteCount',
  'commentCount',
  'ratingCount',
  'rating',
] as const;

const rankingRules = ['sort'];

const filterableAttributes = [
  'id',
  'userId',
  'type',
  'status',
  'checkpointType',
  'baseModel',
  'tagIds',
  'nsfwLevel',
  'poi',
  'minor',
  'earlyAccess',
  'supportsGeneration',
  'fromPlatform',
  'availability',
  'publishedAtUnix',
  'lastVersionAtUnix',
  'collectionId',
  'clubId',
  'fileFormats',
  'isFeatured',
] as const;

export type MetricsModelSearchableAttribute = (typeof searchableAttributes)[number];
export type MetricsModelSortableAttribute = (typeof sortableAttributes)[number];
export type MetricsModelFilterableAttribute = (typeof filterableAttributes)[number];

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

export type SearchBaseModel = {
  id: number;
  userId: number;
  name: string;
  description?: string | null;
  type: ModelType;
  status: ModelStatus;
  checkpointType?: CheckpointType;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  sfwOnly: boolean;
  nsfw: boolean;
  locked: boolean;
  allowNoCredit: boolean;
  allowCommercialUse: string;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  earlyAccessDeadline?: Date | null;
  availability: Availability;
  publishedAt?: Date | null;
  lastVersionAt?: Date | null;
  createdAt: Date;
  fromPlatform: boolean;
  mode?: string | null;
};

type Metrics = {
  id: number;
  downloadCount: number;
  favoriteCount: number;
  commentCount: number;
  ratingCount: number;
  rating: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  collectedCount: number;
  tippedAmountCount: number;
};

type ModelVersionInfo = {
  modelId: number;
  baseModel: string;
  lastVersionAt: Date;
  fileFormats: string[];
  supportsGeneration: boolean;
};

type ModelCollections = {
  modelId: number;
  collectionIds: number[];
};

type ModelClubs = {
  modelId: number;
  clubIds: number[];
};

type FeaturedModels = {
  modelId: number;
  isFeatured: boolean;
};

type UserInfo = {
  modelId: number;
  username: string | null;
  deletedAt: Date | null;
  image: string | null;
};

type ModelTags = Awaited<ReturnType<typeof modelTagCache.fetch>>;

const transformData = async ({
  models,
  modelTags,
  metrics,
  modelVersionInfo,
  modelCollections,
  modelClubs,
  featuredModels,
  userInfo,
}: {
  models: SearchBaseModel[];
  modelTags: ModelTags;
  metrics: Metrics[];
  modelVersionInfo: ModelVersionInfo[];
  modelCollections: ModelCollections[];
  modelClubs: ModelClubs[];
  featuredModels: FeaturedModels[];
  userInfo: UserInfo[];
}) => {
  const records = models
    .map((modelRecord) => {
      const modelMetrics = metrics.find((m) => m.id === modelRecord.id) ?? {
        id: modelRecord.id,
        downloadCount: 0,
        favoriteCount: 0,
        commentCount: 0,
        ratingCount: 0,
        rating: 0,
        thumbsUpCount: 0,
        thumbsDownCount: 0,
        collectedCount: 0,
        tippedAmountCount: 0,
      };

      const versionInfo = modelVersionInfo.find((mv) => mv.modelId === modelRecord.id) ?? {
        modelId: modelRecord.id,
        baseModel: 'SD 1.5',
        lastVersionAt: modelRecord.lastVersionAt || modelRecord.createdAt,
        fileFormats: [],
        supportsGeneration: false,
      };

      const collections = modelCollections.find((mc) => mc.modelId === modelRecord.id);
      const clubs = modelClubs.find((mc) => mc.modelId === modelRecord.id);
      const featured = featuredModels.find((fm) => fm.modelId === modelRecord.id);
      const user = userInfo.find((ui) => ui.modelId === modelRecord.id);

      return {
        ...modelRecord,
        ...modelMetrics,
        baseModel: versionInfo.baseModel,
        lastVersionAtUnix: versionInfo.lastVersionAt.getTime(),
        publishedAtUnix: modelRecord.publishedAt?.getTime(),
        earlyAccess: modelRecord.earlyAccessDeadline
          ? new Date() < modelRecord.earlyAccessDeadline
          : false,
        supportsGeneration: versionInfo.supportsGeneration,
        fileFormats: versionInfo.fileFormats,
        collectionId: collections?.collectionIds?.[0], // Primary collection
        clubId: clubs?.clubIds?.[0], // Primary club
        isFeatured: featured?.isFeatured ?? false,
        tagIds: modelTags[modelRecord.id]?.tagIds ?? [],
        username: user?.username ?? null,
        userImage: user?.image ?? null,
        userDeletedAt: user?.deletedAt ?? null,
      };
    })
    .filter(isDefined);

  return records;
};

export type ModelMetricsSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

export const modelsMetricsSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 10,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 100,
  pullSteps: 7,
  prepareBatches: async ({ db, pg, jobContext }, lastUpdatedAt) => {
    const lastUpdateIso = lastUpdatedAt?.toISOString();
    const newItemsQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (
        SELECT
          m.id FROM "Model" m
        WHERE m."status" = 'Published'
        ${lastUpdatedAt ? ` AND m."createdAt" >= '${lastUpdateIso}'` : ``}
        ORDER BY "createdAt" LIMIT 1
      ) as "startId", (
        SELECT MAX (id) FROM "Model" m
        WHERE m."status" = 'Published'
      ) as "endId";
    `);

    jobContext?.on('cancel', newItemsQuery.cancel);
    const newItems = await newItemsQuery.result();
    const { startId, endId } = newItems[0];

    let updateIds: number[] = [];
    if (lastUpdatedAt) {
      const updateStartIso = new Date().toISOString();
      const updatedIdItemsQuery = await pg.cancellableQuery<{ id: number }>(`
        SELECT id
        FROM "Model"
        WHERE "updatedAt" >= '${lastUpdateIso}'
        AND "updatedAt" < '${updateStartIso}'
        AND id < ${startId} -- Since we're already pulling these..
      `);
      const results = await updatedIdItemsQuery.result();
      updateIds = results.map((x) => x.id);
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
      batch.type === 'update' ? Prisma.sql`m.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.raw(`m.id BETWEEN ${batch.startId} AND ${batch.endId}`)
        : undefined,
    ].filter(isDefined);
    logger(`PullData :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

    if (step === 0) {
      const models = await db.$queryRaw<SearchBaseModel[]>`
        SELECT
          m."id",
          m."userId",
          m."name",
          m."description",
          m."type",
          m."status",
          m."checkpointType",
          m."nsfwLevel",
          m.poi,
          m.minor,
          m."sfwOnly",
          m.nsfw,
          m.locked,
          m."allowNoCredit",
          m."allowCommercialUse"::text,
          m."allowDerivatives",
          m."allowDifferentLicense",
          m."earlyAccessDeadline",
          m."availability",
          m."publishedAt",
          m."lastVersionAt",
          m."createdAt",
          m."mode"::text,
          (
            CASE
              WHEN EXISTS (
                SELECT 1 FROM "ModelVersion" mv
                WHERE mv."modelId" = m."id"
                AND mv."trainingStatus" IS NOT NULL
              )
              THEN TRUE
              ELSE FALSE
            END
          ) AS "fromPlatform"
        FROM "Model" m
        WHERE ${Prisma.join(where, ' AND ')}
      `;
      logger(`PullData Complete :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

      if (models.length === 0) {
        return null;
      }

      return {
        models,
      };
    }

    const modelIds = prevData
      ? (prevData as { models: SearchBaseModel[] }).models.map((m) => m.id)
      : [];
    const result = prevData as Record<string, any>;
    const batches = chunk(modelIds, 1000);
    let i = 0;
    let noMoreSteps = false;

    for (const batch of batches) {
      i++;
      const subBatchLogKey = `${i} of ${batches.length}`;

      if (step === 1) {
        logger(`Pulling metrics :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        const metrics = await clickhouse?.$query<Metrics>(`
            SELECT entityId as "id",
                   SUM(if(metricType = 'Download', metricValue, 0)) as "downloadCount",
                   SUM(if(metricType = 'Favorite', metricValue, 0)) as "favoriteCount",
                   SUM(if(metricType = 'Comment', metricValue, 0)) as "commentCount",
                   SUM(if(metricType = 'ThumbsUp', metricValue, 0)) as "thumbsUpCount",
                   SUM(if(metricType = 'ThumbsDown', metricValue, 0)) as "thumbsDownCount",
                   AVG(if(metricType = 'Rating', metricValue, NULL)) as "rating",
                   COUNT(if(metricType = 'Rating', 1, NULL)) as "ratingCount",
                   SUM(if(metricType = 'Collection', metricValue, 0)) as "collectedCount",
                   SUM(if(metricType = 'Tip', metricValue, 0)) as "tippedAmountCount"
            FROM entityMetricEvents
            WHERE entityType = 'Model'
              AND entityId IN (${batch.join(',')})
            GROUP BY id
          `);

        result.metrics ??= [];
        result.metrics.push(...(metrics ?? []));
        continue;
      }

      if (step === 2) {
        logger(`Pulling tags :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Pull tags from cache
        const cacheModelTags = await modelTagCache.fetch(batch);

        result.modelTags ??= {};
        Object.assign(result.modelTags, cacheModelTags);
        continue;
      }

      if (step === 3) {
        logger(`Pulling model version info :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Model version information
        const modelVersionInfo = await db.$queryRaw<ModelVersionInfo[]>`
          SELECT
            mv."modelId",
            MAX(mv."createdAt") as "lastVersionAt",
            string_agg(DISTINCT mv."baseModel", ',') as "baseModel",
            bool_or(
              CASE WHEN gc."covered" IS TRUE THEN TRUE ELSE FALSE END
            ) as "supportsGeneration",
            array_agg(DISTINCT mf."metadata"->>'format') FILTER (
              WHERE mf."metadata"->>'format' IS NOT NULL
            ) as "fileFormats"
          FROM "ModelVersion" mv
          LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv."id"
          LEFT JOIN "ModelFile" mf ON mf."modelVersionId" = mv."id" AND mf."type" = 'Model'
          WHERE mv."modelId" IN (${Prisma.join(batch)})
            AND mv."status" = 'Published'
          GROUP BY mv."modelId"
        `;

        result.modelVersionInfo ??= [];
        result.modelVersionInfo.push(...modelVersionInfo);
        continue;
      }

      if (step === 4) {
        logger(`Pulling collection associations :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Collection associations
        const modelCollections = await db.$queryRaw<ModelCollections[]>`
          SELECT
            ci."modelId",
            array_agg(ci."collectionId") as "collectionIds"
          FROM "CollectionItem" ci
          JOIN "Collection" c ON c."id" = ci."collectionId"
          WHERE ci."modelId" IN (${Prisma.join(batch)})
            AND c."read" = 'Public'
            AND c."availability" != 'Private'
          GROUP BY ci."modelId"
        `;

        result.modelCollections ??= [];
        result.modelCollections.push(...modelCollections);
        continue;
      }

      if (step === 5) {
        logger(`Pulling club and featured info :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // Club associations
        const modelClubs = await db.$queryRaw<ModelClubs[]>`
          SELECT
            mv."modelId",
            array_agg(DISTINCT COALESCE(ea."accessorId", ct."clubId")) as "clubIds"
          FROM "ModelVersion" mv
          JOIN "EntityAccess" ea ON ea."accessToId" = mv."id" AND ea."accessToType" = 'ModelVersion'
          LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id"
          WHERE mv."modelId" IN (${Prisma.join(batch)})
            AND (ea."accessorType" = 'Club' OR ea."accessorType" = 'ClubTier')
          GROUP BY mv."modelId"
        `;

        result.modelClubs ??= [];
        result.modelClubs.push(...modelClubs);

        // Featured models - using the collection-based approach
        const featuredModels = await db.$queryRaw<FeaturedModels[]>`
          SELECT
            ci."modelId",
            TRUE as "isFeatured"
          FROM "CollectionItem" ci
          WHERE ci."modelId" IN (${Prisma.join(batch)})
            AND ci."collectionId" = 1
        `;

        result.featuredModels ??= [];
        result.featuredModels.push(...featuredModels);
        continue;
      }

      if (step === 6) {
        logger(`Pulling user info :: ${indexName} ::`, batchLogKey, subBatchLogKey);
        // User information
        const userInfo = await db.$queryRaw<UserInfo[]>`
          SELECT
            m."id" as "modelId",
            u."username",
            u."deletedAt",
            u."image"
          FROM "Model" m
          JOIN "User" u ON m."userId" = u."id"
          WHERE m."id" IN (${Prisma.join(batch)})
        `;

        result.userInfo ??= [];
        result.userInfo.push(...userInfo);
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
