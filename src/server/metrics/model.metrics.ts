import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { templateHandler } from '~/server/db/db-helpers';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import {
  executeRefresh,
  executeRefreshWithParams,
  getMetricJson,
  snippets,
} from '~/server/metrics/metric-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import { modelsSearchIndex } from '~/server/search-index';
import { getLastAuctionReset } from '~/server/services/auction.service';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { allInjectableResourceIds } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:model');
const BATCH_SIZE = 200;

type ModelMetricContext = MetricProcessorRunContext & {
  queuedModelVersions: number[];
  isBeginningOfDay: boolean;
};

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctxRaw) {
    // Add the queued model versions to the context
    //---------------------------------------
    const ctx = ctxRaw as ModelMetricContext;
    ctx.queuedModelVersions = [];
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
            FROM jsonb_array_elements(${downloads}::jsonb) mvs
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
    FROM (
      SELECT
        arrayJoin(resourcesUsed) as modelVersionId
      FROM orchestration.jobs
      WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')
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
            FROM jsonb_array_elements(${generations}::jsonb) mvs
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
        AND r."modelVersionId" = ANY(${ids}::int[])
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
      WHERE dg."modelVersionId" = ANY(${ids}::int[])
        AND dg."modelVersionId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY dg."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = now();
    `;
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

  const auctionReset = await getLastAuctionReset();
  if (!auctionReset) {
    log('No auction start date found');
    return [];
  }

  const data = await ctx.ch.$query<{ modelVersionId: number }>`
      WITH affected AS (
        SELECT DISTINCT modelVersionId
        FROM buzz_resource_compensation
        WHERE date = toStartOfDay(${ctx.lastUpdate})
      )
      SELECT
      modelVersionId,
      SUM(total) as earned,
      sumIf(total, date >= ${auctionReset}) as earned_week -- Since Auction Reset
      FROM buzz_resource_compensation
      WHERE modelVersionId IN (SELECT modelVersionId FROM affected)
      GROUP BY modelVersionId;
  `;

  const tasks = chunk(data, BATCH_SIZE).map((batchData, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getVersionBuzzEarnedTasks', i + 1, 'of', tasks.length);

    await executeRefresh(ctx)`
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "earnedAmount")
      SELECT mvm.modelVersionId,
             mvm.timeframe,
             mvm.earned
      FROM (
        SELECT
          CAST(mvs::json ->> 'modelVersionId' AS INT) AS modelVersionId,
          tf.timeframe,
          CAST(
              CASE
                WHEN tf.timeframe = 'Week' THEN mvs::json ->> 'earned_week'
                WHEN tf.timeframe = 'AllTime' THEN mvs::json ->> 'earned'
              END
          AS int) as earned
        FROM jsonb_array_elements(${batchData}::jsonb) mvs
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      ) mvm
      WHERE mvm.earned IS NOT NULL
        AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion")
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
        SET "earnedAmount" = EXCLUDED."earnedAmount",
            "updatedAt"     = now();
    `;

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

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate model rating metrics into JSON
      WITH metric_data AS (
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
          AND r."modelId" = ANY(${ids}::int[])
        GROUP BY r."modelId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'modelId', "modelId",
          'timeframe', timeframe,
          'thumbsUpCount', "thumbsUpCount",
          'thumbsDownCount', "thumbsDownCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated model rating metrics
        INSERT INTO "ModelMetric" ("modelId", timeframe, "thumbsUpCount", "thumbsDownCount")
        SELECT
          (value->>'modelId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'thumbsUpCount')::int,
          (value->>'thumbsDownCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("modelId", timeframe) DO UPDATE
          SET "thumbsUpCount" = EXCLUDED."thumbsUpCount",
              "thumbsDownCount" = EXCLUDED."thumbsDownCount",
              "updatedAt" = now()`,
        [JSON.stringify(metrics)]
      );
    }

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
        AND c."modelId" = ANY(${ids}::int[])
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
    ORDER BY "modelId"
  `;

  const tasks = chunk(affected, BATCH_SIZE).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking
    const metrics = await getMetricJson(ctx)`
      -- Aggregate model collection metrics into JSON
      WITH Timeframes AS (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ),
      metric_data AS (
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
        WHERE c."modelId" = ANY(${ids}::int[])
          AND c."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        GROUP BY c."modelId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'modelId', "modelId",
          'timeframe', timeframe,
          'collectedCount', "collectedCount"
        )
      ) as data
      FROM metric_data
    `;

    // Then perform the insert from the aggregated data
    if (metrics) {
      await executeRefreshWithParams(
        ctx,
        `-- Insert pre-aggregated model collection metrics
        INSERT INTO "ModelMetric" ("modelId", timeframe, "collectedCount")
        SELECT
          (value->>'modelId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'collectedCount')::int
        FROM jsonb_array_elements($1::jsonb) AS value
        ON CONFLICT ("modelId", timeframe) DO UPDATE
          SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = now()`,
        [JSON.stringify(metrics)]
      );
    }

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
          AND bt."entityId" = ANY(${ids}::int[])
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
        WHERE mv."modelId" = ANY(${ids}::int[])
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
      INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", "imageCount", "generationCount", "earnedAmount", "updatedAt")
      SELECT
        mv."modelId",
        mvm.timeframe,
        SUM(mvm."downloadCount") "downloadCount",
        SUM(mvm."imageCount") "imageCount",
        SUM(mvm."generationCount") "generationCount",
        SUM(mvm."earnedAmount") "earnedAmount",
        now() "updatedAt"
      FROM "ModelVersionMetric" mvm
      JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
      WHERE mv."modelId" = ANY(${ids}::int[])
        AND mv."modelId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY mv."modelId", mvm.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE
        SET "updatedAt" = now(),
        "downloadCount" = EXCLUDED."downloadCount",
        "imageCount" = EXCLUDED."imageCount",
        "generationCount" = EXCLUDED."generationCount",
        "earnedAmount" = EXCLUDED."earnedAmount";
    `;
    log('getModelTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

export async function purgeWeeklyEarnedStats(db: PrismaClient) {
  await db.$executeRaw`
    UPDATE "ModelVersionMetric" SET "earnedAmount" = 0
    WHERE "earnedAmount" > 0 AND timeframe = 'Week'
    -- Only purge old records
    AND "updatedAt" < date_trunc('day', now())
  `;

  await db.$executeRaw`
    UPDATE "ModelMetric" SET "earnedAmount" = 0
    WHERE "earnedAmount" > 0 AND timeframe = 'Week'
    -- Only purge old records
    AND "updatedAt" < date_trunc('day', now())
  `;
}
