import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getEntityMetricTasks } from '~/server/metrics/metric-helpers';
import { modelsSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model-collection');

type ModelCollectionMetricContext = MetricProcessorRunContext & {
  updates: Record<number, { modelId: number; collectedCount?: number }>;
  idKey: string;
};

export const modelCollectionMetrics = createMetricProcessor({
  name: 'ModelCollection',
  async update(ctxRaw) {
    const ctx = ctxRaw as ModelCollectionMetricContext;
    ctx.updates = {};
    ctx.idKey = 'modelId';

    // Get collection tasks - uses 5-minute agg boundary from getEntityMetricTasks
    const collectionTasks = await getCollectionTasks(ctx);
    log('modelCollectionMetrics update', collectionTasks.length, 'tasks');
    await limitConcurrency(collectionTasks, 2);

    // Bulk insert model metrics for collectedCount only
    await bulkInsertCollectionMetrics(ctx);

    // Update the search index for affected models
    if (ctx.affected.size > 0) {
      log('update search index', ctx.affected.size, 'models');
      await modelsSearchIndex.queueUpdate(
        [...ctx.affected].map((id) => ({
          id,
          action: SearchIndexUpdateQueueAction.Update,
        }))
      );
    }
  },
  rank: {
    async refresh() {
      // No rank refresh needed for collection metrics
    },
    refreshInterval: 60 * 1000,
  },
});

async function getCollectionTasks(ctx: ModelCollectionMetricContext) {
  return getEntityMetricTasks(ctx)('Model', 'collectedCount');
}

async function bulkInsertCollectionMetrics(ctx: ModelCollectionMetricContext) {
  const updates = Object.values(ctx.updates);
  if (!updates.length) {
    log('no collection metrics to insert');
    return;
  }

  const tasks = chunk(updates, 100).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('insert collection metrics', i + 1, 'of', tasks.length);

    await executeRefresh(ctx)`
      -- insert collection metrics
      WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("modelId" INT, "collectedCount" INT))
      INSERT INTO "ModelMetric" ("modelId", "updatedAt", "collectedCount")
      SELECT
        d."modelId",
        NOW() as "updatedAt",
        COALESCE(d."collectedCount", im."collectedCount", 0) as "collectedCount"
      FROM data d
      LEFT JOIN "ModelMetric" im ON im."modelId" = d."modelId"
      WHERE EXISTS (SELECT 1 FROM "Model" WHERE id = d."modelId")
      ON CONFLICT ("modelId") DO UPDATE
        SET
          "collectedCount" = EXCLUDED."collectedCount",
          "updatedAt" = NOW()
    `;
    log('insert collection metrics', i + 1, 'of', tasks.length, 'done');
  });

  await limitConcurrency(tasks, 10);
}
