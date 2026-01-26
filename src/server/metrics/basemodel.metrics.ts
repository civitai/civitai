import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh } from '~/server/metrics/metric-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:basemodel');
const BATCH_SIZE = 500;
const AGGREGATION_CONCURRENCY = 5;

const baseModelMetricKeys = ['thumbsUpCount', 'downloadCount', 'imageCount'] as const;
type BaseModelMetricKey = (typeof baseModelMetricKeys)[number];

type BaseModelMetricUpdate = {
  modelId: number;
  baseModel: string;
} & Partial<Record<BaseModelMetricKey, number>>;

type BaseModelMetricContext = MetricProcessorRunContext & {
  queuedModelVersions: number[];
  baseModelUpdates: Record<string, BaseModelMetricUpdate>; // key is `${modelId}:${baseModel}`
};

export const baseModelMetrics = createMetricProcessor({
  name: 'BaseModel',
  async update(ctxRaw) {
    const ctx = ctxRaw as BaseModelMetricContext;
    ctx.queuedModelVersions = [];
    ctx.baseModelUpdates = {};

    const jobStart = Date.now();
    log('========== STARTING baseModelMetrics update ==========');
    log('lastUpdate:', ctx.lastUpdate.toISOString());
    log('queue size:', ctx.queue.length);

    // Get queued model versions for the queued models
    if (ctx.queue.length > 0) {
      const queueStart = Date.now();
      const queuedModelVersions = await ctx.db.$queryRaw<{ id: number }[]>`
        SELECT id
        FROM "ModelVersion"
        WHERE "modelId" IN (${Prisma.join(ctx.queue)})
      `;
      ctx.queuedModelVersions = queuedModelVersions.map((x) => x.id);
      log(`queued model versions: ${ctx.queuedModelVersions.length} (${Date.now() - queueStart}ms)`);
    }

    // Get base model aggregation tasks
    const aggStart = Date.now();
    const baseModelTasks = await getBaseModelAggregationTasks(ctx);
    log(`baseModelMetrics aggregation tasks: ${baseModelTasks.length} (task creation: ${Date.now() - aggStart}ms)`);

    const aggExecStart = Date.now();
    await limitConcurrency(baseModelTasks, AGGREGATION_CONCURRENCY);
    const aggDuration = Date.now() - aggExecStart;
    log(`aggregation phase complete: ${Object.keys(ctx.baseModelUpdates).length} updates (${aggDuration}ms)`);

    // Bulk insert base model metrics
    const insertStart = Date.now();
    await bulkInsertBaseModelMetrics(ctx);
    const insertDuration = Date.now() - insertStart;
    log(`insert phase complete (${insertDuration}ms)`);

    const totalDuration = Date.now() - jobStart;
    log('========== baseModelMetrics update COMPLETE ==========');
    log(`TOTAL TIME: ${totalDuration}ms (${(totalDuration / 1000).toFixed(1)}s)`);
    log(`  - Aggregation: ${aggDuration}ms (${((aggDuration / totalDuration) * 100).toFixed(1)}%)`);
    log(`  - Insert: ${insertDuration}ms (${((insertDuration / totalDuration) * 100).toFixed(1)}%)`);
  },
  rank: {
    async refresh() {
      // No rank refresh needed for base model metrics
    },
    refreshInterval: 60 * 1000,
  },
});

function getAffected(ctx: BaseModelMetricContext) {
  return templateHandler(async (sql) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql);
    ctx.jobContext.on('cancel', affectedQuery.cancel);
    const affected = await affectedQuery.result();
    const idsSet = new Set(ctx.queue);
    affected.forEach((x) => idsSet.add(x.id));
    const ids = [...idsSet].sort((a, b) => a - b);
    ctx.addAffected(ids);

    return ids;
  });
}

async function getBaseModelAggregationTasks(ctx: BaseModelMetricContext) {
  // Find all model IDs that had version metrics updated or reviews updated
  const affectedStart = Date.now();
  const affected = await getAffected(ctx)`
    SELECT DISTINCT mv."modelId" as id
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
    WHERE mvm."updatedAt" > '${ctx.lastUpdate}'
  `;

  log(`affected models found: ${affected.length} (query: ${Date.now() - affectedStart}ms)`);
  if (affected.length > 0) {
    log(`model ID range: ${affected[0]} - ${affected[affected.length - 1]}`);
  }

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    const batchStart = Date.now();
    log(`[batch ${i + 1}/${tasks.length}] starting | models: ${ids.length} | range: ${ids[0]}-${ids[ids.length - 1]}`);

    // Run version stats and review stats queries in parallel for better performance
    const queryStart = Date.now();
    const [versionStats, reviewStats] = await Promise.all([
      getVersionStatsForBatch(ctx, ids),
      getReviewStatsForBatch(ctx, ids),
    ]);
    const queryDuration = Date.now() - queryStart;

    // Merge results - version stats are the primary source (defines which baseModels exist)
    for (const vs of versionStats) {
      const key = `${vs.modelId}:${vs.baseModel}`;
      ctx.baseModelUpdates[key] = {
        modelId: vs.modelId,
        baseModel: vs.baseModel,
        downloadCount: parseInt(vs.downloadCount) || 0,
        imageCount: parseInt(vs.imageCount) || 0,
        thumbsUpCount: 0, // Will be filled by review stats
      };
    }

    // Apply review stats
    for (const rs of reviewStats) {
      const key = `${rs.modelId}:${rs.baseModel}`;
      if (ctx.baseModelUpdates[key]) {
        ctx.baseModelUpdates[key].thumbsUpCount = parseInt(rs.thumbsUpCount) || 0;
      }
    }

    const batchDuration = Date.now() - batchStart;
    log(
      `[batch ${i + 1}/${tasks.length}] done | versionStats: ${versionStats.length} | reviewStats: ${reviewStats.length} | queries: ${queryDuration}ms | total: ${batchDuration}ms`
    );
  });

  return tasks;
}

async function getVersionStatsForBatch(
  ctx: BaseModelMetricContext,
  ids: number[]
): Promise<{ modelId: number; baseModel: string; downloadCount: string; imageCount: string }[]> {
  const query = await ctx.pg.cancellableQuery<{
    modelId: number;
    baseModel: string;
    downloadCount: string;
    imageCount: string;
  }>(
    `-- aggregate version metrics by base model (downloadCount, imageCount)
    SELECT
      mv."modelId",
      mv."baseModel",
      SUM(mvm."downloadCount") as "downloadCount",
      SUM(mvm."imageCount") as "imageCount"
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
    WHERE mv."modelId" = ANY($1::int[])
      AND mv."modelId" BETWEEN $2 AND $3
      AND mv."status" = 'Published'
    GROUP BY mv."modelId", mv."baseModel"`,
    [ids, ids[0], ids[ids.length - 1]]
  );
  ctx.jobContext.on('cancel', query.cancel);
  return query.result();
}

async function getReviewStatsForBatch(
  ctx: BaseModelMetricContext,
  ids: number[]
): Promise<{ modelId: number; baseModel: string; thumbsUpCount: string }[]> {
  const query = await ctx.pg.cancellableQuery<{
    modelId: number;
    baseModel: string;
    thumbsUpCount: string;
  }>(
    `-- aggregate review stats by base model (thumbsUpCount)
    SELECT
      mv."modelId",
      mv."baseModel",
      COUNT(DISTINCT r."userId") FILTER (WHERE r.recommended = true) as "thumbsUpCount"
    FROM "ResourceReview" r
    JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
    WHERE mv."modelId" = ANY($1::int[])
      AND mv."modelId" BETWEEN $2 AND $3
      AND mv."status" = 'Published'
      AND r.exclude = false
      AND r."tosViolation" = false
    GROUP BY mv."modelId", mv."baseModel"`,
    [ids, ids[0], ids[ids.length - 1]]
  );
  ctx.jobContext.on('cancel', query.cancel);
  return query.result();
}

async function bulkInsertBaseModelMetrics(ctx: BaseModelMetricContext) {
  const updates = Object.values(ctx.baseModelUpdates);
  if (!updates.length) {
    log('no base model metrics to insert');
    return;
  }

  log(`inserting base model metrics | total records: ${updates.length} | batches: ${Math.ceil(updates.length / 250)}`);

  const tasks = chunk(updates, 250).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    const insertStart = Date.now();

    // Use raw SQL for upsert with composite key
    await executeRefresh(ctx)`
      -- insert base model metrics
      WITH data AS (
        SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x(
          "modelId" INT,
          "baseModel" TEXT,
          "thumbsUpCount" INT,
          "downloadCount" INT,
          "imageCount" INT
        )
      )
      INSERT INTO "ModelBaseModelMetric" (
        "modelId", "baseModel", "thumbsUpCount", "downloadCount", "imageCount", "updatedAt",
        "status", "availability", "mode", "nsfwLevel", "minor", "poi"
      )
      SELECT
        d."modelId",
        d."baseModel",
        COALESCE(d."thumbsUpCount", 0),
        COALESCE(d."downloadCount", 0),
        COALESCE(d."imageCount", 0),
        NOW(),
        m."status",
        m."availability",
        m."mode",
        m."nsfwLevel",
        m."minor",
        m."poi"
      FROM data d
      JOIN "Model" m ON m.id = d."modelId"
      ON CONFLICT ("modelId", "baseModel") DO UPDATE
        SET
          "thumbsUpCount" = EXCLUDED."thumbsUpCount",
          "downloadCount" = EXCLUDED."downloadCount",
          "imageCount" = EXCLUDED."imageCount",
          "updatedAt" = NOW()
    `;

    log(`[insert ${i + 1}/${tasks.length}] ${batch.length} records (${Date.now() - insertStart}ms)`);
  });

  await limitConcurrency(tasks, 10);
  log('all base model metrics inserted');
}
