import { chunk } from 'lodash-es';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { buildEntityMetricPerDaySource, getEntityMetricAggSource } from '~/server/flipt/client';

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
    // Subtract a 2-minute buffer so events that landed slightly late (or after
    // the ReplacingMergeTree dedup settled) near the previous boundary aren't
    // missed. Overlap is harmless here — entityIds are deduped downstream.
    const lastUpdatedAtBuffered = new Date(lastUpdatedAt.getTime() - 2 * 60 * 1000);
    const ids = await ch.$query<{ id: number }>`
      SELECT
        distinct entityId as "id"
      FROM entityMetricEvents_month
      WHERE entityType = 'Image'
      AND createdAt > ${lastUpdatedAtBuffered}
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
    const aggSource = await getEntityMetricAggSource();
    const tasks = chunk(ids, 5000).map((batch) => async () => {
      const perDaySource = buildEntityMetricPerDaySource(
        aggSource,
        `WHERE entityType = 'Image'
            AND entityId IN (${batch.join(',')})`
      );
      const results = await ch?.$query<Metrics>(`
        SELECT entityId as "id",
          sumIf(total, metricType in ('Like', 'Heart', 'Laugh', 'Cry')) as "reactionCount",
          sumIf(total, metricType = 'commentCount') as "commentCount",
          sumIf(total, metricType = 'Collection') as "collectedCount"
        FROM ${perDaySource}
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
