import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { PG_INT4_MAX, PG_INT4_MIN } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh } from '~/server/metrics/metric-helpers';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { modelsSearchIndex } from '~/server/search-index';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { allInjectableResourceIds } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model');
const BATCH_SIZE = 200;

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
  updates: Record<number, Record<string, number>>;
  idKey: string;
};

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctxRaw) {
    // Add the queued model versions to the context
    //---------------------------------------
    const ctx = ctxRaw as ModelMetricContext;
    ctx.queuedModelVersions = [];
    ctx.versionUpdates = {};
    ctx.updates = {};
    ctx.idKey = 'modelId';
    ctx.isBeginningOfDay = dayjs(ctx.lastUpdate).isSame(dayjs().subtract(1, 'day'), 'day');
    if (ctx.queue.length > 0) {
      const queuedModelVersions = await ctx.db.$queryRaw<{ id: number }[]>`
        SELECT id
        FROM "ModelVersion"
        WHERE "modelId" = ANY(${ctx.queue}::int[])
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
    await bulkInsertMetrics(ctx, Object.values(ctx.updates), modelMetricKeys, {
      table: 'ModelMetric',
      logName: 'model metrics',
    });

    // If beginning of day - clear top earners cache
    //---------------------------------------
    if (ctx.isBeginningOfDay) bustFetchThroughCache(REDIS_KEYS.CACHES.TOP_EARNERS);

    // Update the search index
    //---------------------------------------
    // The metric job runs every minute and `ctx.affected` is dominated
    // by `getVersionAggregationTasks` — any model whose ModelVersionMetric
    // updatedAt changed in the last minute (downloads / generations etc.).
    // On production that's ~1,900 distinct model ids per minute, even though
    // only ~35 of those reflect a user-visible mutation. The models search-
    // index sync cron is `*/15`, so queueing every minute generates 15×
    // more work than the consumer can drain and the backlog grows forever.
    //
    // Accumulate affected ids into a Redis SET (deduplicates across ticks)
    // and only flush to the search-index queue every ~15 minutes. The
    // service-layer queueUpdate calls in model.service / model-version.service
    // for genuine mutations (publish, edit, tag changes, etc.) are unaffected
    // and still hit the search-index queue immediately on the user's request.
    if (ctx.affected.size > 0) {
      log('accumulate search index updates', ctx.affected.size);
      await sysRedis.sAdd(
        REDIS_SYS_KEYS.INDEX_UPDATES.MODEL_METRIC_AFFECTED,
        [...ctx.affected].map(String)
      );
    }

    const FLUSH_INTERVAL_MS = 15 * 60 * 1000;
    const lastFlushStr = await sysRedis.get(
      REDIS_SYS_KEYS.INDEX_UPDATES.MODEL_METRIC_LAST_FLUSH
    );
    const lastFlush = lastFlushStr ? new Date(lastFlushStr).getTime() : 0;
    const shouldFlush = Date.now() - lastFlush >= FLUSH_INTERVAL_MS;

    if (shouldFlush) {
      const pendingRaw = await sysRedis.sMembers(
        REDIS_SYS_KEYS.INDEX_UPDATES.MODEL_METRIC_AFFECTED
      );
      // Mark the flush before draining so a crash mid-flush doesn't
      // double-queue.
      //
      // Trade-off: if the process dies between the SET drain and the
      // queueUpdate call, those ids stall in the search index until a
      // NEW mvm.updatedAt change re-touches them (the mvm cursor is
      // independent — it advances even for runs whose flush succeeds).
      // For cold/idle models that may be hours. Accept this because
      // (a) crash-window is small, (b) the next genuine user mutation
      // re-indexes via the untouched service-layer path, (c) metric-
      // drift staleness on the search doc is by definition cosmetic.
      await sysRedis.set(
        REDIS_SYS_KEYS.INDEX_UPDATES.MODEL_METRIC_LAST_FLUSH,
        new Date().toISOString()
      );
      if (pendingRaw.length > 0) {
        await sysRedis.del(REDIS_SYS_KEYS.INDEX_UPDATES.MODEL_METRIC_AFFECTED);
        log('flush search index updates', pendingRaw.length);
        // Chunk so a runaway accumulator (e.g. a Postgres mvm backfill
        // bumping every row's updatedAt) doesn't push a single multi-MB
        // request into the search-index queue path.
        const QUEUE_CHUNK_SIZE = 5000;
        for (const slice of chunk(pendingRaw, QUEUE_CHUNK_SIZE)) {
          await modelsSearchIndex.queueUpdate(
            slice.map((id) => ({
              id: Number(id),
              action: SearchIndexUpdateQueueAction.Update,
            }))
          );
        }
      }
    }
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
    idColumn?: string;
    logName: string;
  }
) {
  const { table } = options;
  const idColumn = options.idColumn ?? ctx.idKey;
  const metricInsertColumns = metrics.map((key) => `"${key}" INT`).join(', ');
  const metricInsertKeys = metrics.map((key) => `"${key}"`).join(', ');
  const metricValues = metrics
    .map((key) => `COALESCE(d."${key}", im."${key}", 0) as "${key}"`)
    .join(',\n');
  const metricOverrides = metrics.map((key) => `"${key}" = EXCLUDED."${key}"`).join(',\n');
  // Only bump the row when a value actually moved. `updatedAt` gates the
  // search-index enqueue (getVersionAggregationTasks → ctx.affected), so a
  // re-SUM that returns the same count must stay a no-op — otherwise every
  // still-active-today version re-queues to Meili each run and the write
  // volume ramps through the UTC day.
  const targetTuple = metrics.map((key) => `"${table}"."${key}"`).join(', ');
  const excludedTuple = metrics.map((key) => `EXCLUDED."${key}"`).join(', ');

  const tasks = chunk(updates, 100).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(`insert ${options.logName}`, i + 1, 'of', tasks.length);

    const offenders: Array<{ id: any; key: string; value: any }> = [];
    for (const row of batch as any[]) {
      for (const key of metrics) {
        const value = row[key];
        if (value == null) continue;
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value > PG_INT4_MAX ||
          value < PG_INT4_MIN
        ) {
          offenders.push({ id: row[idColumn], key, value });
        }
      }
    }
    if (offenders.length > 0) {
      log(
        `⚠️  out-of-range ${options.logName} (${offenders.length}) batch ${i + 1}/${tasks.length}:`,
        JSON.stringify(offenders)
      );
    }

    try {
      await executeRefresh(ctx)`
        -- insert ${options.logName}
        WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("${idColumn}" INT, ${metricInsertColumns}))
        INSERT INTO "${options.table}" ("${idColumn}", "updatedAt", ${metricInsertKeys})
        SELECT
          d."${idColumn}",
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "${table}" im ON im."${idColumn}" = d."${idColumn}"
        WHERE EXISTS (SELECT 1 FROM "${table.replace('Metric', '')}" WHERE id = d."${idColumn}")
        ON CONFLICT ("${idColumn}") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
          WHERE (${targetTuple}) IS DISTINCT FROM (${excludedTuple})
      `;
    } catch (err) {
      const ids = (batch as any[]).map((r) => r[idColumn]);
      log(
        `❌ insert ${options.logName} failed batch ${i + 1}/${tasks.length} ids:`,
        JSON.stringify(ids),
        'rows:',
        JSON.stringify(batch)
      );
      throw err;
    }
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
    const entityId = row.modelId;
    ctx.updates[entityId] ??= { [ctx.idKey]: entityId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === ctx.idKey) continue;
      const value = row[key];
      if (value == null) continue;
      (ctx.updates[entityId] as any)[key] = typeof value === 'string' ? parseInt(value) : value;
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
  // Flag every version generated since the start of the day containing
  // lastUpdate (createdDate >= toDate(lastUpdate)) — normally today, but wider
  // on the first run past UTC midnight or after an outage, which usefully
  // re-reconciles the prior day's tail. Then re-SUM its all-time count below.
  // `daily_resource_generation_counts` is built asynchronously from
  // `orchestration.jobs`, so a job's contribution lands in the MV after the job
  // row exists. Flagging by `jobs.createdAt >= lastUpdate` (a 1-minute window)
  // therefore re-SUMs before the new counts settle and never revisits the
  // version once it goes quiet, freezing the metric at an undercount. Re-summing
  // all of today's active versions every minute reconciles that tail. The Meili
  // write-volume ramp this breadth used to cause no longer forms: bulkInsertMetrics
  // only bumps updatedAt on an actual value change, so a re-SUM returning the same
  // count is a no-op and never re-queues the version to the search index.
  const generated = await ctx.ch.$query<{ modelVersionId: number }>`
    SELECT DISTINCT modelVersionId
    FROM orchestration.daily_resource_generation_counts
    WHERE createdDate >= toDate(${ctx.lastUpdate})
      AND createdDate <= today()
      AND modelVersionId > 0
      AND count <= ${PG_INT4_MAX}
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
        AND createdDate <= today()
        AND count <= ${PG_INT4_MAX}
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

  // Seed commentCount to 0 for all affected models so that models with zero
  // remaining comments get explicitly set to 0 instead of falling through to
  // the COALESCE fallback which preserves the stale value.
  for (const id of affected) {
    ctx.updates[id] ??= { [ctx.idKey]: id };
    ctx.updates[id].commentCount ??= 0;
  }

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
