import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { templateHandler } from '~/server/db/db-helpers';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { executeRefresh, snippets } from '~/server/metrics/metric-helpers';
import { modelsSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { allInjectableResourceIds } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model');
const BATCH_SIZE = 1000;

type ModelMetricContext = MetricProcessorRunContext & {
  queuedModelVersions: number[];
};

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctxRaw) {
    // Add the queued model versions to the context
    //---------------------------------------
    const ctx = ctxRaw as ModelMetricContext;
    ctx.queuedModelVersions = [];
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
    for (const tasks of modelTasks) await limitConcurrency(tasks, 5);

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

type VersionTimeframeRow = {
  modelVersionId: number;
  day: number;
  week: number;
  month: number;
  year: number;
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
             uniqMergeIf(users_state, createdDate = current_date())                     day,
             uniqMergeIf(users_state, createdDate >= subtractDays(current_date(), 7))   week,
             uniqMergeIf(users_state, createdDate >= subtractMonths(current_date(), 1)) month,
             uniqMergeIf(users_state, createdDate >= subtractYears(current_date(), 1))  year,
             uniqMerge(users_state)                                                     all_time
      FROM daily_downloads_unique
      WHERE modelVersionId IN (${ids})
      GROUP BY modelVersionId;
    `;

    ctx.jobContext.checkIfCanceled();
    const downloadsJson = JSON.stringify(downloads);
    await executeRefresh(ctx)`
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount")
      SELECT mvm.modelVersionId,
             mvm.timeframe,
             mvm.downloads
      FROM (SELECT CAST(mvs::json ->> 'modelVersionId' AS INT) AS modelVersionId,
                   tf.timeframe,
                   CAST(
                     CASE
                       WHEN tf.timeframe = 'Day' THEN mvs::json ->> 'day'
                       WHEN tf.timeframe = 'Week' THEN mvs::json ->> 'week'
                       WHEN tf.timeframe = 'Month' THEN mvs::json ->> 'month'
                       WHEN tf.timeframe = 'Year' THEN mvs::json ->> 'year'
                       WHEN tf.timeframe = 'AllTime' THEN mvs::json ->> 'all_time'
                       END
                     AS int)                                   as downloads
            FROM json_array_elements('${downloadsJson}'::json) mvs
                   CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf) mvm
      WHERE mvm.downloads IS NOT NULL
        AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion")
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "downloadCount" = EXCLUDED."downloadCount",
            "updatedAt"     = now();
    `;

    log('getDownloadTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

const injectedVersionIds = allInjectableResourceIds;

async function getGenerationTasks(ctx: ModelMetricContext) {
  const generated = await ctx.ch.$query<{ modelVersionId: number }>`
    SELECT DISTINCT modelVersionId
    FROM (SELECT arrayJoin(resourcesUsed) as modelVersionId
          FROM orchestration.textToImageJobs
          WHERE createdAt >= ${ctx.lastUpdate})
  `;
  const affected = generated
    .map((x) => x.modelVersionId)
    .filter((x) => !injectedVersionIds.includes(x));

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getGenerationTasks', i + 1, 'of', tasks.length);
    const generations = await ctx.ch.$query<VersionTimeframeRow>`
      SELECT modelVersionId,
             countIf(date = current_date())                     day,
             countIf(date >= subtractDays(current_date(), 7))   week,
             countIf(date >= subtractMonths(current_date(), 1)) month,
             countIf(date >= subtractYears(current_date(), 1))  year,
             count(*)                                           all_time
      FROM daily_user_resource
      WHERE modelVersionId IN (${ids})
      GROUP BY modelVersionId;
    `;

    ctx.jobContext.checkIfCanceled();
    const generationsJson = JSON.stringify(generations);
    await executeRefresh(ctx)`
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "generationCount")
      SELECT mvm.modelVersionId,
             mvm.timeframe,
             mvm.generations
      FROM (SELECT CAST(mvs::json ->> 'modelVersionId' AS INT) AS modelVersionId,
                   tf.timeframe,
                   CAST(
                     CASE
                       WHEN tf.timeframe = 'Day' THEN mvs::json ->> 'day'
                       WHEN tf.timeframe = 'Week' THEN mvs::json ->> 'week'
                       WHEN tf.timeframe = 'Month' THEN mvs::json ->> 'month'
                       WHEN tf.timeframe = 'Year' THEN mvs::json ->> 'year'
                       WHEN tf.timeframe = 'AllTime' THEN mvs::json ->> 'all_time'
                       END
                     AS int)                                   as generations
            FROM json_array_elements('${generationsJson}'::json) mvs
                   CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf) mvm
      WHERE mvm.generations IS NOT NULL
        AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion")
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "generationCount" = EXCLUDED."generationCount",
            "updatedAt"       = now();
    `;

    log('getGenerationTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getImageTasks(ctx: ModelMetricContext) {
  const affected = await getAffected(ctx, 'ModelVersion')`
    -- Get recent model image uploads
    SELECT DISTINCT
      ir."modelVersionId" as id
    FROM "Image" i
    JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
    JOIN "Post" p ON i."postId" = p.id
    WHERE p."publishedAt" BETWEEN '${ctx.lastUpdate}' AND now();
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getImageTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update model image metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "imageCount")
      SELECT
        "modelVersionId",
        timeframe,
        ${snippets.timeframeSum('i."publishedAt"')} "imageCount"
      FROM (
        SELECT
          ir."modelVersionId",
          p."publishedAt"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        JOIN "ImageResource" ir ON mv.id = ir."modelVersionId"
        JOIN "Image" i ON i.id = ir."imageId" AND m."userId" != i."userId"
        JOIN "Post" p ON i."postId" = p.id AND p."publishedAt" IS NOT NULL AND p."publishedAt" < now()
        WHERE
          mv.id IN (${ids})
      ) i
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      GROUP BY "modelVersionId", timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "imageCount" = EXCLUDED."imageCount", "updatedAt" = now();
    `;
    log('getImageTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

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
    await executeRefresh(ctx)`
      -- update version rating metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "thumbsUpCount", "thumbsDownCount")
      SELECT
        r."modelVersionId",
        tf.timeframe,
        ${snippets.timeframeCount('r."createdAt"', 'r."userId"', 'recommended')} "thumbsUpCount",
        ${snippets.timeframeCount(
          'r."createdAt"',
          'r."userId"',
          'NOT recommended'
        )} "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelVersionId" IN (${ids})
        AND r."modelVersionId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY r."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
    `;
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
    await executeRefresh(ctx)`
      -- update version rating metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "tippedCount", "tippedAmountCount", "updatedAt")
      SELECT
        dg."modelVersionId",
        tf.timeframe,
        ${snippets.timeframeCount('d."createdAt"', 'amount')} "tippedCount",
        ${snippets.timeframeSum('d."createdAt"', 'amount')} "tippedAmountCount",
        now() "updatedAt"
      FROM "Donation" d
      JOIN "DonationGoal" dg ON dg.id = d."donationGoalId"
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE dg."modelVersionId" IN (${ids})
        AND db."modelVersionId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY dg."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = now();
    `;
    log('getVersionBuzzTasks', i + 1, 'of', tasks.length, 'done');
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
    await executeRefresh(ctx)`
      -- update model rating metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "thumbsUpCount", "thumbsDownCount")
      SELECT
        r."modelId",
        tf.timeframe,
        ${snippets.timeframeCount('r."createdAt"', 'r."userId"', 'recommended')} "thumbsUpCount",
        ${snippets.timeframeCount(
          'r."createdAt"',
          'r."userId"',
          'NOT recommended'
        )} "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelId" IN (${ids})
        AND r."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY r."modelId", tf.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
    `;
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
    await executeRefresh(ctx)`
      -- update model comment metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "commentCount")
      SELECT
          c."modelId",
          tf.timeframe,
          ${snippets.timeframeCount('c."createdAt"', 'c."userId"')} "commentCount"
      FROM "Comment" c
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE c."tosViolation" = false
        AND c."modelId" IN (${ids})
        AND c."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY c."modelId", tf.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = now();
    `;
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
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update model collect metrics
      WITH Timeframes AS (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      )
      INSERT INTO "ModelMetric" ("modelId", timeframe, "collectedCount")
      SELECT
        c."modelId",
        tf.timeframe,
        COUNT(DISTINCT c."addedById") AS "collectedCount"
      FROM "CollectionItem" c
      JOIN Timeframes tf ON 
        (tf.timeframe = 'AllTime')
        OR (tf.timeframe = 'Year' AND c."createdAt" > NOW() - INTERVAL '365 days')
        OR (tf.timeframe = 'Month' AND c."createdAt" > NOW() - INTERVAL '30 days')
        OR (tf.timeframe = 'Week' AND c."createdAt" > NOW() - INTERVAL '7 days')
        OR (tf.timeframe = 'Day' AND c."createdAt" > NOW() - INTERVAL '1 day')
      JOIN "Model" m ON m.id = c."modelId" -- ensure model exists
      WHERE c."modelId" = ANY (ARRAY[${ids}])
        AND c."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY c."modelId", tf.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = now();
    `;
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
    await executeRefresh(ctx)`
      -- update model tip metrics
      WITH "tips" AS (
        SELECT
          "entityId" as "modelId",
          tf.timeframe,
          ${snippets.timeframeCount('bt."updatedAt"', 'bt."amount"')} "tippedCount",
          ${snippets.timeframeSum('bt."updatedAt"', 'bt."amount"')} "tippedAmountCount"
        FROM "BuzzTip" bt
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
        WHERE bt."entityType" = 'Model' AND bt."entityId" IS NOT NULL
          AND bt."entityId" IN (${ids})
          AND bt."entityId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        GROUP BY "entityId", tf.timeframe
      ), "versionTips" AS (
        SELECT
          mv."modelId",
          mvm.timeframe,
          SUM(mvm."tippedCount") "tippedCount",
          SUM(mvm."tippedAmountCount") "tippedAmountCount"
        FROM "ModelVersionMetric" mvm
        JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
        WHERE mv."modelId" IN (${ids})
          AND mv."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        GROUP BY mv."modelId", mvm.timeframe
      )
      INSERT INTO "ModelMetric" ("modelId", timeframe, "tippedCount", "tippedAmountCount")
      SELECT
        tips."modelId",
        tips.timeframe,
        (tips."tippedCount" + "versionTips"."tippedCount") "tippedCount",
        (tips."tippedAmountCount" + "versionTips"."tippedAmountCount") "tippedAmountCount"
      FROM tips
      JOIN "versionTips" ON tips."modelId" = "versionTips"."modelId" AND tips.timeframe = "versionTips".timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = now();
    `;
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
    await executeRefresh(ctx)`
      -- Migrate model thumbs up metrics
      INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", "imageCount", "generationCount", "updatedAt")
      SELECT
        mv."modelId",
        mvm.timeframe,
        SUM(mvm."downloadCount") "downloadCount",
        SUM(mvm."imageCount") "imageCount",
        SUM(mvm."generationCount") "generationCount",
        now() "updatedAt"
      FROM "ModelVersionMetric" mvm
      JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
      WHERE mv."modelId" IN (${ids})
        AND mv."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY mv."modelId", mvm.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "updatedAt" = now(), "downloadCount" = EXCLUDED."downloadCount", "imageCount" = EXCLUDED."imageCount", "generationCount" = EXCLUDED."generationCount";
    `;
    log('getModelTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
