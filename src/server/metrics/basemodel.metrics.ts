import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh } from '~/server/metrics/metric-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:basemodel');
const BATCH_SIZE = 200;

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

    log('starting baseModelMetrics update');
    log('lastUpdate:', ctx.lastUpdate.toISOString());
    log('queue size:', ctx.queue.length);

    // Get queued model versions for the queued models
    if (ctx.queue.length > 0) {
      const queuedModelVersions = await ctx.db.$queryRaw<{ id: number }[]>`
        SELECT id
        FROM "ModelVersion"
        WHERE "modelId" IN (${Prisma.join(ctx.queue)})
      `;
      ctx.queuedModelVersions = queuedModelVersions.map((x) => x.id);
      log('queued model versions:', ctx.queuedModelVersions.length);
    }

    // Get base model aggregation tasks
    const baseModelTasks = await getBaseModelAggregationTasks(ctx);
    log('baseModelMetrics aggregation tasks:', baseModelTasks.length);
    for (const task of baseModelTasks) await task();

    log('total base model updates collected:', Object.keys(ctx.baseModelUpdates).length);

    // Bulk insert base model metrics
    await bulkInsertBaseModelMetrics(ctx);

    log('baseModelMetrics update complete');
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
  const affected = await getAffected(ctx)`
    SELECT DISTINCT mv."modelId" as id
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
    WHERE mvm."updatedAt" > '${ctx.lastUpdate}'
  `;

  log('affected models found:', affected.length);
  if (affected.length > 0) {
    log('model ID range:', affected[0], '-', affected[affected.length - 1]);
  }

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(
      'getBaseModelAggregationTasks batch',
      i + 1,
      'of',
      tasks.length,
      '| models:',
      ids.length,
      '| range:',
      ids[0],
      '-',
      ids[ids.length - 1]
    );

    // Aggregate version metrics grouped by (modelId, baseModel)
    // - downloadCount and imageCount: sum from ModelVersionMetric
    // - thumbsUpCount: count unique users from ResourceReview
    const query = await ctx.pg.cancellableQuery<{
      modelId: number;
      baseModel: string;
      thumbsUpCount: string;
      downloadCount: string;
      imageCount: string;
    }>(
      `-- aggregate version metrics by base model
      WITH version_stats AS (
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
        GROUP BY mv."modelId", mv."baseModel"
      ),
      review_stats AS (
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
        GROUP BY mv."modelId", mv."baseModel"
      )
      SELECT
        vs."modelId",
        vs."baseModel",
        COALESCE(rs."thumbsUpCount", 0) as "thumbsUpCount",
        vs."downloadCount",
        vs."imageCount"
      FROM version_stats vs
      LEFT JOIN review_stats rs ON rs."modelId" = vs."modelId" AND rs."baseModel" = vs."baseModel"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();

    for (const row of data) {
      const key = `${row.modelId}:${row.baseModel}`;
      ctx.baseModelUpdates[key] = {
        modelId: row.modelId,
        baseModel: row.baseModel,
        thumbsUpCount: parseInt(row.thumbsUpCount) || 0,
        downloadCount: parseInt(row.downloadCount) || 0,
        imageCount: parseInt(row.imageCount) || 0,
      };
    }

    log(
      'getBaseModelAggregationTasks batch',
      i + 1,
      'of',
      tasks.length,
      'done | rows:',
      data.length
    );
  });

  return tasks;
}

async function bulkInsertBaseModelMetrics(ctx: BaseModelMetricContext) {
  const updates = Object.values(ctx.baseModelUpdates);
  if (!updates.length) {
    log('no base model metrics to insert');
    return;
  }

  log('inserting base model metrics | total records:', updates.length);

  const tasks = chunk(updates, 100).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('insert base model metrics batch', i + 1, 'of', tasks.length, '| records:', batch.length);

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

    log('insert base model metrics batch', i + 1, 'of', tasks.length, 'done');
  });

  await limitConcurrency(tasks, 10);
  log('all base model metrics inserted');
}
