import { Prisma } from '@prisma/client';
import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { metricsSearchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';

const READ_BATCH_SIZE = 10000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = `${METRICS_IMAGES_SEARCH_INDEX}_NEW`;
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

// TODO.imageMetrics create another index updater for specifically updating metrics
export const imagesMetricsDetailsSearchIndexUpdateMetrics = createSearchIndexUpdateProcessor({
  workerCount: 15,
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 20, // Avoids hogging too much memory.
  resetInMainIndex: true,
  pullSteps: 1,
  prepareBatches: async ({ db, pg, jobContext }, lastUpdatedAt) => {
    // TODO.imageMetrics set updatedAt on image when post is published
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
  pullData: async ({ db }, batch) => {
    const ids =
      batch.type === 'update'
        ? batch.ids
        : Array.from({ length: batch.endId - batch.startId + 1 }, (_, i) => batch.startId + i);

    // TODO: imageMetrics get metrics from clickHouse.
    const metrics = await db.$queryRaw`
          SELECT
            im."imageId" as id,
            im."collectedCount" as "collectedCount",
            im."reactionCount" as "reactionCount",
            im."commentCount" as "commentCount"
          FROM "ImageMetric" im
          WHERE im."imageId" IN (${Prisma.join(ids)})
            AND im."timeframe" = 'AllTime'::"MetricTimeframe"
      `;

    return metrics;
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
