import { clickhouse } from '~/server/clickhouse/client';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

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
};

type Metrics = {
  id: number;
  reactionCount: number;
  commentCount: number;
  collectedCount: number;
};

const transformData = async (metrics: Metrics[]) => {
  const records = metrics;
  return records;
};

export const imagesMetricsDetailsSearchIndexUpdateMetrics = createSearchIndexUpdateProcessor({
  workerCount: 15,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  resetInMainIndex: true,
  pullSteps: 1,
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
        const ids = await clickhouse?.$query<{ id: number }>(`
          SELECT
            distinct entityId as "id"
          FROM entityMetricEvents
          WHERE entityType = 'Image'
          AND createdAt > '${lastUpdatedAt}'
          AND entityId > ${lastId}
          ORDER BY entityId
          LIMIT ${READ_BATCH_SIZE};
        `);

        if (!ids || ids.length) {
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
  pullData: async ({ db }, batch) => {
    const ids =
      batch.type === 'update'
        ? batch.ids
        : Array.from({ length: batch.endId - batch.startId + 1 }, (_, i) => batch.startId + i);

    const metrics = await clickhouse?.$query<Metrics>(`
          SELECT entityId as "id",
                 SUM(if(
                     metricType in ('ReactionLike', 'ReactionHeart', 'ReactionLaugh', 'ReactionCry'), metricValue, 0
                 )) as "reactionCount",
                 SUM(if(metricType = 'Comment', metricValue, 0)) as "commentCount",
                 SUM(if(metricType = 'Collection', metricValue, 0)) as "collectedCount"
          FROM entityMetricEvents
          WHERE entityType = 'Image'
            AND entityId IN (${ids.join(',')})
          GROUP BY id
        `);

    return metrics ?? [];
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
