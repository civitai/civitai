/**
 * Metrics Models Search Index
 *
 * Populates the metrics_models_v1 Meilisearch index with model data.
 * Uses the ModelsFeed from event-engine-common for document creation.
 */

import { chunk } from 'lodash-es';
import { METRICS_MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { isDefined } from '~/utils/type-guards';
import { clickhouse } from '~/server/clickhouse/client';
import { redis } from '~/server/redis/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { MetricService } from '../../../event-engine-common/services/metrics';
import { CacheService } from '../../../event-engine-common/services/cache';
import type {
  IClickhouseClient,
  IDbClient,
  IRedisClient,
} from '../../../event-engine-common/types/package-stubs';
import type { IMeilisearch } from '../../../event-engine-common/types/meilisearch-interface';
import { ModelsFeed } from '../../../event-engine-common/feeds/models.feed';
import type { ModelDocument } from '../../../event-engine-common/types/model-feed-types';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = METRICS_MODELS_SEARCH_INDEX;

const searchableAttributes = ['name'] as const;

const sortableAttributes = [
  'id',
  'lastVersionAtUnix',
  'downloadCount',
  'thumbsUpCount',
  'thumbsDownCount',
  'commentCount',
  'collectedCount',
  'tippedAmountCount',
  'imageCount',
] as const;

const rankingRules = ['sort', 'attribute', 'words', 'proximity', 'exactness'];

const filterableAttributes = [
  'id',
  'type',
  'nsfw',
  'nsfwLevel',
  'minor',
  'poi',
  'sfwOnly',
  'status',
  'mode',
  'availability',
  'locked',
  'lastVersionAtUnix',
  'publishedAtUnix',
  'earlyAccessDeadlineUnix',
  'downloadCount',
  'thumbsUpCount',
  'thumbsDownCount',
  'commentCount',
  'collectedCount',
  'tippedAmountCount',
  'imageCount',
  'userId',
  'tagIds',
  'baseModels',
  'modelVersionIds',
  'allowNoCredit',
  'allowDerivatives',
  'allowDifferentLicense',
  'allowCommercialUse',
  'supportsGeneration',
  'fromPlatform',
  'checkpointType',
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

  const searchableAttributesSorted = [...searchableAttributes].sort();
  const sortableAttributesSorted = [...sortableAttributes].sort();
  const filterableAttributesSorted = [...filterableAttributes].sort();

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

// Create a singleton ModelsFeed instance for reuse
let modelsFeedInstance: InstanceType<typeof ModelsFeed> | null = null;

function getModelsFeed(): InstanceType<typeof ModelsFeed> {
  if (!modelsFeedInstance) {
    modelsFeedInstance = new ModelsFeed(
      () => client as IMeilisearch,
      clickhouse as IClickhouseClient,
      pgDbWrite as IDbClient,
      new MetricService(clickhouse as IClickhouseClient, redis as unknown as IRedisClient),
      new CacheService(
        redis as unknown as IRedisClient,
        pgDbWrite as IDbClient,
        clickhouse as IClickhouseClient
      )
    );
  }
  return modelsFeedInstance;
}

/**
 * Transform ModelDocument to a format suitable for Meilisearch
 * Converts Date objects to Unix timestamps
 */
function transformDocumentForMeilisearch(doc: ModelDocument): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    type: doc.type,
    nsfw: doc.nsfw,
    nsfwLevels: doc.nsfwLevels,
    minor: doc.minor,
    poi: doc.poi,
    sfwOnly: doc.sfwOnly,
    status: doc.status,
    mode: doc.mode,
    availability: doc.availability,
    locked: doc.locked,
    lastVersionAtUnix: doc.lastVersionAtUnix,
    publishedAtUnix: doc.publishedAtUnix,
    earlyAccessDeadlineUnix: doc.earlyAccessDeadlineUnix,
    downloadCount: doc.downloadCount,
    thumbsUpCount: doc.thumbsUpCount,
    thumbsDownCount: doc.thumbsDownCount,
    commentCount: doc.commentCount,
    collectedCount: doc.collectedCount,
    tippedAmountCount: doc.tippedAmountCount,
    imageCount: doc.imageCount,
    userId: doc.userId,
    tagIds: doc.tagIds,
    baseModels: doc.baseModels,
    modelVersionIds: doc.modelVersionIds,
    allowNoCredit: doc.allowNoCredit,
    allowDerivatives: doc.allowDerivatives,
    allowDifferentLicense: doc.allowDifferentLicense,
    allowCommercialUse: doc.allowCommercialUse,
    supportsGeneration: doc.supportsGeneration,
    fromPlatform: doc.fromPlatform,
    checkpointType: doc.checkpointType,
  };
}

export type ModelMetricsSearchIndexRecord = ReturnType<typeof transformDocumentForMeilisearch>;

export const modelsMetricsSearchIndex = createSearchIndexUpdateProcessor({
  workerCount: 5,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 100,
  pullSteps: 1,
  prepareBatches: async ({ pg, jobContext }, lastUpdatedAt) => {
    const lastUpdateIso = lastUpdatedAt?.toISOString();

    // Query to find the range of model IDs to index
    const rangeQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (
        SELECT
          mm."modelId" FROM "ModelMetric" mm
        ${lastUpdatedAt ? `WHERE mm."updatedAt" >= '${lastUpdateIso}'` : ''}
        ORDER BY mm."modelId" LIMIT 1
      ) as "startId", (
        SELECT MAX("modelId") FROM "ModelMetric"
      ) as "endId";
    `);

    jobContext?.on('cancel', rangeQuery.cancel);
    const rangeResult = await rangeQuery.result();
    const { startId, endId } = rangeResult[0];

    let updateIds: number[] = [];
    if (lastUpdatedAt) {
      // Find models that were updated since last run but before startId
      const updateStartIso = new Date().toISOString();
      const updatedIdItemsQuery = await pg.cancellableQuery<{ modelId: number }>(`
        SELECT mm."modelId"
        FROM "ModelMetric" mm
        WHERE mm."updatedAt" >= '${lastUpdateIso}'
          AND mm."updatedAt" < '${updateStartIso}'
          AND mm."modelId" < ${startId}
      `);
      const results = await updatedIdItemsQuery.result();
      updateIds = results.map((x) => x.modelId);
    }

    return {
      batchSize: READ_BATCH_SIZE,
      startId: startId ?? 0,
      endId: endId ?? 0,
      updateIds,
    };
  },
  pullData: async ({ logger, indexName }, batch) => {
    const batchLogKey =
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length;
    logger(`PullData :: ${indexName} :: Pulling data for batch ::`, batchLogKey);

    // Get the model IDs for this batch
    let modelIds: number[];
    if (batch.type === 'new') {
      // Generate array of IDs from startId to endId
      modelIds = [];
      for (let i = batch.startId; i <= batch.endId; i++) {
        modelIds.push(i);
      }
    } else {
      modelIds = batch.ids;
    }

    if (modelIds.length === 0) {
      return null;
    }

    // Use ModelsFeed to create documents
    const feed = getModelsFeed();
    const documents = await feed.createDocuments(modelIds, 'full');

    logger(`PullData :: ${indexName} :: Pulled ${documents.length} documents`);

    return documents;
  },
  transformData: async (documents: ModelDocument[]) => {
    // Transform documents for Meilisearch (convert Date objects to timestamps)
    return documents.map(transformDocumentForMeilisearch).filter(isDefined);
  },
  pushData: async ({ logger, indexName }, documents: ModelMetricsSearchIndexRecord[]) => {
    if (documents.length === 0) {
      return;
    }

    logger(`PushData :: ${indexName} :: Pushing ${documents.length} documents`);

    // Push in batches to avoid overwhelming Meilisearch
    const batches = chunk(documents, MEILISEARCH_DOCUMENT_BATCH_SIZE);
    for (const docBatch of batches) {
      await updateDocs({
        indexName,
        documents: docBatch,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
        client,
      });
    }

    logger(`PushData :: ${indexName} :: Pushed ${documents.length} documents`);
  },
  client,
});

/**
 * Separate processor for metrics-only updates
 * Updates only the metric fields without re-indexing all model data
 */
export const modelsMetricsSearchIndexUpdateMetrics = createSearchIndexUpdateProcessor({
  workerCount: 3,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 50,
  pullSteps: 1,
  partial: true,
  prepareBatches: async ({ pg, jobContext }, lastUpdatedAt) => {
    // For metrics updates, we look at recently changed metrics in ClickHouse
    // or ModelMetric table updates
    const lastUpdateIso = lastUpdatedAt?.toISOString() ?? new Date(0).toISOString();

    const rangeQuery = await pg.cancellableQuery<{ startId: number; endId: number }>(`
      SELECT (
        SELECT MIN("modelId") FROM "ModelMetric"
        WHERE "updatedAt" >= '${lastUpdateIso}'
      ) as "startId", (
        SELECT MAX("modelId") FROM "ModelMetric"
        WHERE "updatedAt" >= '${lastUpdateIso}'
      ) as "endId";
    `);

    jobContext?.on('cancel', rangeQuery.cancel);
    const rangeResult = await rangeQuery.result();
    const { startId, endId } = rangeResult[0];

    return {
      batchSize: READ_BATCH_SIZE,
      startId: startId ?? 0,
      endId: endId ?? 0,
      updateIds: [],
    };
  },
  pullData: async ({ logger, indexName }, batch) => {
    const batchLogKey =
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length;
    logger(`PullData :: ${indexName} :: Pulling metrics for batch ::`, batchLogKey);

    let modelIds: number[];
    if (batch.type === 'new') {
      modelIds = [];
      for (let i = batch.startId; i <= batch.endId; i++) {
        modelIds.push(i);
      }
    } else {
      modelIds = batch.ids;
    }

    if (modelIds.length === 0) {
      return null;
    }

    // Use ModelsFeed to create metrics-only documents
    const feed = getModelsFeed();
    const documents = await feed.createDocuments(modelIds, 'metrics');

    logger(`PullData :: ${indexName} :: Pulled ${documents.length} metric documents`);

    return documents;
  },
  transformData: async (documents: ModelDocument[]) => {
    // For metrics updates, we only need the metric fields
    return documents
      .map((doc) => ({
        id: doc.id,
        downloadCount: doc.downloadCount,
        thumbsUpCount: doc.thumbsUpCount,
        thumbsDownCount: doc.thumbsDownCount,
        commentCount: doc.commentCount,
        collectedCount: doc.collectedCount,
        tippedAmountCount: doc.tippedAmountCount,
        imageCount: doc.imageCount,
      }))
      .filter(isDefined);
  },
  pushData: async ({ logger, indexName }, documents: Partial<ModelMetricsSearchIndexRecord>[]) => {
    if (documents.length === 0) {
      return;
    }

    logger(`PushData :: ${indexName} :: Pushing ${documents.length} metric updates`);

    const batches = chunk(documents, MEILISEARCH_DOCUMENT_BATCH_SIZE);
    for (const docBatch of batches) {
      await updateDocs({
        indexName,
        documents: docBatch,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
        client,
      });
    }

    logger(`PushData :: ${indexName} :: Pushed ${documents.length} metric updates`);
  },
  client,
});
