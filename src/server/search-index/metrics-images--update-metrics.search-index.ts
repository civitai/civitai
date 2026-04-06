import { chunk } from 'lodash-es';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const READ_BATCH_SIZE = 100000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
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
};

type Metrics = {
  id: number;
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
};

export const imagesMetricsDetailsSearchIndexUpdateMetrics = createSearchIndexUpdateProcessor({
  workerCount: 1,
  indexName: INDEX_ID,
  jobName: `${INDEX_ID}_metrics`,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  partial: true,
  prepareBatches: async ({ ch }, lastUpdatedAt) => {
    if (!ch) return { batchSize: 0, startId: 0, endId: 0, updateIds: [] };

    // TODO somehow check for postId existence, otherwise there are lots of unused rows

    lastUpdatedAt ??= new Date(1723528353000);
    const ids = await ch.$query<{ id: number }>`
      SELECT
        distinct entityId as "id"
      FROM entityMetricEvents
      WHERE entityType = 'Image'
      AND createdAt > ${lastUpdatedAt}
    `;
    const updateIds = ids?.map((x) => x.id) ?? [];

    return {
      batchSize: READ_BATCH_SIZE,
      startId: 0,
      endId: 0,
      updateIds,
    };
  },
  pullData: async ({ ch, logger }, batch) => {
    const ids =
      batch.type === 'update'
        ? batch.ids
        : Array.from({ length: batch.endId - batch.startId + 1 }, (_, i) => batch.startId + i);

    const metrics: Metrics[] = [];
    const tasks = chunk(ids, 5000).map((batch) => async () => {
      const results = await ch?.$query<Metrics>(`
        SELECT entityId as "id",
          sumIf(total, metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry')) as "reactionCount",
          sumIf(total, metricType = 'Comment') as "commentCount",
          sumIf(total, metricType = 'Collection') as "collectedCount"
        FROM entityMetricDailyAgg
        WHERE entityType = 'Image'
          AND entityId IN (${batch.join(',')})
        GROUP BY id
      `);
      if (results?.length) metrics.push(...results);
    });
    await limitConcurrency(tasks, 5);
    logger('Pulled', metrics.length, 'metrics');
    return metrics;
  },
  transformData: async (metrics: Metrics[]) => metrics,
  pushData: async ({ indexName, logger }, data) => {
    logger('Pushing data to index', data.length);
    if (data.length <= 0) return;

    await updateDocs({
      indexName,
      documents: data,
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      client,
    });
  },
  client,
});
