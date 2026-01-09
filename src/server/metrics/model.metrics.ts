import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh } from '~/server/metrics/metric-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import { modelsSearchIndex } from '~/server/search-index';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { allInjectableResourceIds } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model');
const BATCH_SIZE = 1000;

const versionMetricKeys = [
  'downloadCount',
  'generationCount',
  'thumbsUpCount',
  'thumbsDownCount',
  'tippedCount',
  'tippedAmountCount',
  'earnedAmount',
] as const;

const modelMetricKeys = [
  'thumbsUpCount',
  'thumbsDownCount',
  'commentCount',
  'collectedCount',
  'tippedCount',
  'tippedAmountCount',
  'downloadCount',
  'imageCount',
  'generationCount',
  'earnedAmount',
] as const;

type ModelVersionMetricKey = (typeof versionMetricKeys)[number];
type ModelMetricKey = (typeof modelMetricKeys)[number];

type ModelMetricContext = MetricProcessorRunContext & {
  queuedModelVersions: number[];
  isBeginningOfDay: boolean;
  versionUpdates: Record<
    number,
    Partial<Record<ModelVersionMetricKey, number>> & { modelVersionId: number }
  >;
  modelUpdates: Record<number, Partial<Record<ModelMetricKey, number>> & { modelId: number }>;
};

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctxRaw) {
    // Add the queued model versions to the context
    //---------------------------------------
    const ctx = ctxRaw as ModelMetricContext;
    ctx.queuedModelVersions = [];
    ctx.versionUpdates = {};
    ctx.modelUpdates = {};
    ctx.isBeginningOfDay = dayjs(ctx.lastUpdate).isSame(dayjs().subtract(1, 'day'), 'day');
    if (ctx.queue.length > 0) {
      const queuedModelVersions = await ctx.db.$queryRaw<{ id: number }[]>`
        SELECT id
        FROM "ModelVersion"
        WHERE "modelId" IN (${Prisma.join(ctx.queue)})
      `;
      ctx.queuedModelVersions = queuedModelVersions.map((x) => x.id);
    }

    // Get the metric tasks
    //---------------------------------------
    const versionTasks = await Promise.all([
      getDownloadTasks(ctx),
      getGenerationTasks(ctx),
      getVersionRatingTasks(ctx),
      getVersionBuzzTasks(ctx),
      getVersionBuzzEarnedTasks(ctx),
    ]);
    log('modelVersionMetrics update', versionTasks.flat().length, 'tasks');
    for (const tasks of versionTasks) await limitConcurrency(tasks, 5);

    const modelTasks = await Promise.all([
      getModelRatingTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      getVersionAggregationTasks(ctx),
    ]);
    log('modelMetrics update', modelTasks.flat().length, 'tasks');
    for (const tasks of modelTasks) await limitConcurrency(tasks, 2);

    // Bulk insert version metrics
    //---------------------------------------
    await bulkInsertMetrics(ctx, Object.values(ctx.versionUpdates), versionMetricKeys, {
      table: 'ModelVersionMetric',
      idColumn: 'modelVersionId',
      logName: 'version metrics',
    });

    // Bulk insert model metrics
    //---------------------------------------
    await bulkInsertMetrics(ctx, Object.values(ctx.modelUpdates), modelMetricKeys, {
      table: 'ModelMetric',
      idColumn: 'modelId',
      logName: 'model metrics',
    });

    // If beginning of day - clear top earners cache
    //---------------------------------------
    if (ctx.isBeginningOfDay) bustFetchThroughCache(REDIS_KEYS.CACHES.TOP_EARNERS);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await modelsSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  },
  rank: {
    async refresh() {
      // Do nothing. Rank views are now not used.
    },
    refreshInterval: 60 * 1000,
  },
});

function getAffected(ctx: ModelMetricContext, type: 'Model' | 'ModelVersion') {
  return templateHandler(async (sql) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql);
    ctx.jobContext.on('cancel', affectedQuery.cancel);
    const affected = await affectedQuery.result();
    const queue = type === 'Model' ? ctx.queue : ctx.queuedModelVersions;
    const idsSet = new Set(queue);
    affected.forEach((x) => idsSet.add(x.id));
    const ids = [...idsSet].sort((a, b) => a - b);
    if (type === 'Model') ctx.addAffected(ids);

    return ids;
  });
}

async function bulkInsertMetrics<T extends readonly string[]>(
  ctx: ModelMetricContext,
  updates: Record<number, any>[],
  metrics: T,
  options: {
    table: string;
    idColumn: string;
    logName: string;
  }
) {
  const { table, idColumn } = options;
  const metricInsertColumns = metrics.map((key) => `"${key}" INT`).join(', ');
  const metricInsertKeys = metrics.map((key) => `"${key}"`).join(', ');
  const metricValues = metrics
    .map((key) => `COALESCE(d."${key}", im."${key}", 0) as "${key}"`)
    .join(',\n');
  const metricOverrides = metrics.map((key) => `"${key}" = EXCLUDED."${key}"`).join(',\n');

  const tasks = chunk(updates, 100).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(`insert ${options.logName}`, i + 1, 'of', tasks.length);

    await executeRefresh(ctx)`
      -- insert ${options.logName}
      WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("${idColumn}" INT, ${metricInsertColumns}))
      INSERT INTO "${options.table}" ("${idColumn}", "updatedAt", ${metricInsertKeys})
      SELECT
        d."${options.idColumn}",
        NOW() as "updatedAt",
        ${metricValues}
      FROM data d
      LEFT JOIN "${table}" im ON im."${idColumn}" = d."${idColumn}"
      WHERE EXISTS (SELECT 1 FROM "${table.replace('Metric', '')}" WHERE id = d."${idColumn}")
      ON CONFLICT ("${options.idColumn}") DO UPDATE
        SET
          ${metricOverrides},
          "updatedAt" = NOW()
    `;
    log(`insert ${options.logName}`, i + 1, 'of', tasks.length, 'done');
  });
  await limitConcurrency(tasks, 10);
}

async function getVersionMetrics(ctx: ModelMetricContext, sql: string, params: any[] = []) {
  const query = await ctx.pg.cancellableQuery<
    { modelVersionId: number } & Record<string, string | number>
  >(sql, params);
  ctx.jobContext.on('cancel', query.cancel);
  const data = await query.result();
  if (!data.length) return;

  for (const row of data) {
    const versionId = row.modelVersionId;
    ctx.versionUpdates[versionId] ??= { modelVersionId: versionId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === 'modelVersionId') continue;
      const value = row[key];
      if (value == null) continue;
      (ctx.versionUpdates[versionId] as any)[key] =
        typeof value === 'string' ? parseInt(value) : value;
    }
  }
}

async function getModelMetrics(ctx: ModelMetricContext, sql: string, params: any[] = []) {
  const query = await ctx.pg.cancellableQuery<
    { modelId: number } & Record<string, string | number>
  >(sql, params);
  ctx.jobContext.on('cancel', query.cancel);
  const data = await query.result();
  if (!data.length) return;

  for (const row of data) {
    const modelId = row.modelId;
    ctx.modelUpdates[modelId] ??= { modelId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === 'modelId') continue;
      const value = row[key];
      if (value == null) continue;
      (ctx.modelUpdates[modelId] as any)[key] = typeof value === 'string' ? parseInt(value) : value;
    }
  }
}

type VersionTimeframeRow = {
  modelVersionId: number;
  all_time: number;
};

async function getDownloadTasks(ctx: ModelMetricContext) {
  const downloaded = await ctx.ch.$query<{ modelVersionId: number }>`
    SELECT DISTINCT modelVersionId
    FROM modelVersionEvents
    WHERE type = 'Download'
      AND time >= ${ctx.lastUpdate};
  `;
  const affected = downloaded.map((x) => x.modelVersionId);

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getDownloadTasks', i + 1, 'of', tasks.length);
    const downloads = await ctx.ch.$query<VersionTimeframeRow>`
      SELECT modelVersionId,
             uniqMerge(users_state) all_time
      FROM daily_downloads_unique
      WHERE modelVersionId IN (${ids})
      GROUP BY modelVersionId;
    `;

    ctx.jobContext.checkIfCanceled();
    for (const row of downloads) {
      const versionId = row.modelVersionId;
      ctx.versionUpdates[versionId] ??= { modelVersionId: versionId };
      ctx.versionUpdates[versionId].downloadCount = row.all_time;
    }

    log('getDownloadTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

const injectedVersionIds = allInjectableResourceIds;

async function getGenerationTasks(ctx: ModelMetricContext) {
  const generated = await ctx.ch.$query<{ modelVersionId: number }>`
    SELECT DISTINCT modelVersionId
    FROM (
      SELECT
        arrayJoin(resourcesUsed) as modelVersionId
      FROM orchestration.jobs
      WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy', 'falFlux2Image')
        AND createdAt >= ${ctx.lastUpdate}
    )
  `;
  const affected = generated
    .map((x) => x.modelVersionId)
    .filter((x) => !injectedVersionIds.includes(x));

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getGenerationTasks', i + 1, 'of', tasks.length);
    const generations = await ctx.ch.$query<VersionTimeframeRow>`
      SELECT
        modelVersionId,
        SUM(count) AS all_time
      FROM orchestration.daily_resource_generation_counts
      WHERE modelVersionId IN (${ids})
      GROUP BY modelVersionId;
    `;

    ctx.jobContext.checkIfCanceled();
    for (const row of generations) {
      const versionId = row.modelVersionId;
      ctx.versionUpdates[versionId] ??= { modelVersionId: versionId };
      ctx.versionUpdates[versionId].generationCount = row.all_time;
    }

    log('getGenerationTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

// async function getImageTasks(ctx: ModelMetricContext) {
//   const affected = await getAffected(ctx, 'ModelVersion')`
//     -- Get recent model image uploads
//     SELECT DISTINCT
//       ir."modelVersionId" as id
//     FROM "Image" i
//     JOIN "ImageResourceNew" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
//     JOIN "Post" p ON i."postId" = p.id
//     WHERE p."publishedAt" BETWEEN '${ctx.lastUpdate}' AND now();
//   `;

//   const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
//     ctx.jobContext.checkIfCanceled();
//     log('getImageTasks', i + 1, 'of', tasks.length);
//     await executeRefresh(ctx)`
//       -- update model image metrics
//       INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "imageCount")
//       SELECT
//         "modelVersionId",
//         timeframe,
//         ${snippets.timeframeSum('i."publishedAt"')} "imageCount"
//       FROM (
//         SELECT
//           ir."modelVersionId",
//           p."publishedAt"
//         FROM "ModelVersion" mv
//         JOIN "Model" m ON m.id = mv."modelId"
//         JOIN "ImageResourceNew" ir ON mv.id = ir."modelVersionId"
//         JOIN "Image" i ON i.id = ir."imageId" AND m."userId" != i."userId"
//         JOIN "Post" p ON i."postId" = p.id AND p."publishedAt" IS NOT NULL AND p."publishedAt" < now()
//         WHERE
//           mv.id IN (${ids})
//       ) i
//       CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
//       GROUP BY "modelVersionId", timeframe
//       ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
//         SET "imageCount" = EXCLUDED."imageCount", "updatedAt" = now();
//     `;
//     log('getImageTasks', i + 1, 'of', tasks.length, 'done');
//   });

//   return tasks;
// }

async function getVersionRatingTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'ModelVersion')`
    -- get recent version reviews
    SELECT DISTINCT "modelVersionId" as id
    FROM "ResourceReview"
    WHERE "createdAt" > '${ctx.lastUpdate}' OR "updatedAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getRatingTasks', i + 1, 'of', tasks.length);
    await getVersionMetrics(
      ctx,
      `-- get version rating metrics
      SELECT
        r."modelVersionId",
        COUNT(DISTINCT r."userId") FILTER (WHERE recommended) AS "thumbsUpCount",
        COUNT(DISTINCT r."userId") FILTER (WHERE NOT recommended) AS "thumbsDownCount"
      FROM "ResourceReview" r
      WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelVersionId" = ANY($1::int[])
        AND r."modelVersionId" BETWEEN $2 AND $3
      GROUP BY r."modelVersionId"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    log('getRatingTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getVersionBuzzTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'ModelVersion')`
    -- get recent version donations. These are the only way to "tip" a model version
    SELECT DISTINCT "modelVersionId" as id
    FROM "Donation" d
    JOIN "DonationGoal" dg ON dg.id = d."donationGoalId"
    WHERE dg."modelVersionId" IS NOT NULL AND d."createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getVersionBuzzTasks', i + 1, 'of', tasks.length);
    await getVersionMetrics(
      ctx,
      `-- get version tip metrics
      SELECT
        dg."modelVersionId",
        COUNT(amount) AS "tippedCount",
        SUM(amount) AS "tippedAmountCount"
      FROM "Donation" d
      JOIN "DonationGoal" dg ON dg.id = d."donationGoalId"
      WHERE dg."modelVersionId" = ANY($1::int[])
        AND dg."modelVersionId" BETWEEN $2 AND $3
      GROUP BY dg."modelVersionId"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    log('getVersionBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getVersionBuzzEarnedTasks(ctx: ModelMetricContext) {
  // Is ctx.lastUpdate from yesterday?
  if (!ctx.isBeginningOfDay) {
    log('Skipping buzz earned tasks');
    return [];
  }

  const data = await ctx.ch.$query<{ modelVersionId: number; earned: number }>`
      WITH affected AS (
        SELECT DISTINCT modelVersionId
        FROM orchestration.resourceCompensations
        WHERE date = toStartOfDay(${ctx.lastUpdate})
      )
      SELECT
      modelVersionId,
      floor(SUM(amount)) as earned
      FROM orchestration.resourceCompensations
      WHERE modelVersionId IN (SELECT modelVersionId FROM affected)
      GROUP BY modelVersionId;
  `;

  const tasks = chunk(data, BATCH_SIZE).map((batchData, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getVersionBuzzEarnedTasks', i + 1, 'of', tasks.length);

    for (const row of batchData) {
      const versionId = row.modelVersionId;
      ctx.versionUpdates[versionId] ??= { modelVersionId: versionId };
      ctx.versionUpdates[versionId].earnedAmount = row.earned;
    }

    log('getVersionBuzzEarnedTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getModelRatingTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'Model')`
    -- Get recent model reviews
    SELECT DISTINCT "modelId" as id
    FROM "ResourceReview"
    WHERE "createdAt" > '${ctx.lastUpdate}' OR "updatedAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getModelRatingTasks', i + 1, 'of', tasks.length);
    await getModelMetrics(
      ctx,
      `-- get model rating metrics
      SELECT
        r."modelId",
        COUNT(DISTINCT r."userId") FILTER (WHERE recommended) AS "thumbsUpCount",
        COUNT(DISTINCT r."userId") FILTER (WHERE NOT recommended) AS "thumbsDownCount"
      FROM "ResourceReview" r
      WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelId" = ANY($1::int[])
      GROUP BY r."modelId"`,
      [ids]
    );
    log('getModelRatingTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: ModelMetricContext) {
  const commentEvents = await ctx.ch.$query<{ modelId: number }>`
    SELECT DISTINCT entityId AS modelId
    FROM comments
    WHERE time >= ${ctx.lastUpdate}
      AND type = 'Model'
      AND entityId IS NOT NULL
  `;
  const affected = [...new Set([...commentEvents.map((x) => x.modelId), ...ctx.queue])];
  ctx.addAffected(affected);

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await getModelMetrics(
      ctx,
      `-- get model comment metrics
      SELECT
          c."modelId",
          COUNT(DISTINCT c."userId") AS "commentCount"
      FROM "Comment" c
      WHERE c."tosViolation" = false
        AND c."modelId" = ANY($1::int[])
        AND c."modelId" BETWEEN $2 AND $3
      GROUP BY c."modelId"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'Model')`
    -- Get recent model collects
    SELECT DISTINCT "modelId" as id
    FROM "CollectionItem"
    WHERE "modelId" IS NOT NULL AND "createdAt" > '${ctx.lastUpdate}'
    ORDER BY "modelId"
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await getModelMetrics(
      ctx,
      `-- get model collection metrics
      SELECT
        c."modelId",
        COUNT(DISTINCT c."addedById") AS "collectedCount"
      FROM "CollectionItem" c
      JOIN "Model" m ON m.id = c."modelId" -- ensure model exists
      WHERE c."modelId" = ANY($1::int[])
        AND c."modelId" BETWEEN $2 AND $3
      GROUP BY c."modelId"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'Model')`
    -- Get recent model tips
    SELECT DISTINCT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityId" IS NOT NULL AND "entityType" = 'Model'
      AND ("createdAt" > '${ctx.lastUpdate}' OR "updatedAt" > '${ctx.lastUpdate}')

    UNION

    SELECT DISTINCT mv."modelId" as id
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
    WHERE mvm."updatedAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await getModelMetrics(
      ctx,
      `-- get model tip metrics
      WITH "tips" AS (
        SELECT
          "entityId" as "modelId",
          COUNT(bt."amount") AS "tippedCount",
          SUM(bt."amount") AS "tippedAmountCount"
        FROM "BuzzTip" bt
        WHERE bt."entityType" = 'Model' AND bt."entityId" IS NOT NULL
          AND bt."entityId" = ANY($1::int[])
          AND bt."entityId" BETWEEN $2 AND $3
        GROUP BY "entityId"
      ), "versionTips" AS (
        SELECT
          mv."modelId",
          SUM(mvm."tippedCount") "tippedCount",
          SUM(mvm."tippedAmountCount") "tippedAmountCount"
        FROM "ModelVersionMetric" mvm
        JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
        WHERE mv."modelId" = ANY($4::int[])
          AND mv."modelId" BETWEEN $5 AND $6
        GROUP BY mv."modelId"
      )
      SELECT
        COALESCE(tips."modelId", "versionTips"."modelId") as "modelId",
        (COALESCE(tips."tippedCount", 0) + COALESCE("versionTips"."tippedCount", 0)) "tippedCount",
        (COALESCE(tips."tippedAmountCount", 0) + COALESCE("versionTips"."tippedAmountCount", 0)) "tippedAmountCount"
      FROM tips
      FULL OUTER JOIN "versionTips" ON tips."modelId" = "versionTips"."modelId"`,
      [ids, ids[0], ids[ids.length - 1], ids, ids[0], ids[ids.length - 1]]
    );
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getVersionAggregationTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'Model')`
    SELECT DISTINCT mv."modelId" as id
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
    WHERE mvm."updatedAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getModelTasks', i + 1, 'of', tasks.length);
    await getModelMetrics(
      ctx,
      `-- aggregate version metrics to model
      SELECT
        mv."modelId",
        SUM(mvm."downloadCount") "downloadCount",
        SUM(mvm."imageCount") "imageCount",
        SUM(mvm."generationCount") "generationCount",
        SUM(mvm."earnedAmount") "earnedAmount"
      FROM "ModelVersionMetric" mvm
      JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
      WHERE mv."modelId" = ANY($1::int[])
        AND mv."modelId" BETWEEN $2 AND $3
      GROUP BY mv."modelId"`,
      [ids, ids[0], ids[ids.length - 1]]
    );
    log('getModelTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
