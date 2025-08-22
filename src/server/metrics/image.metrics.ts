import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { limitConcurrency, sleep } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import type { ImageMetric } from '~/shared/utils/prisma/models';
import { templateHandler } from '~/server/db/db-helpers';
import { getJobDate } from '~/server/jobs/job';
import type { Dayjs } from 'dayjs';

const log = createLogger('metrics:image');

export const imageMetrics = createMetricProcessor({
  disabled: true,
  name: 'Image',
  async update(baseCtx) {
    const ctx = baseCtx as ImageMetricContext;
    const [lastViewUpdateDate, setLastViewUpdate] = await getJobDate('metric:image:views');
    const lastViewUpdate = dayjs(lastViewUpdateDate);
    ctx.updates = {};
    ctx.lastViewUpdate = lastViewUpdate;
    ctx.setLastViewUpdate = setLastViewUpdate;

    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
      getBuzzTasks(ctx),
      // getViewTasks(ctx),
    ]);
    // const hasViewTasks = taskBatches[4].length > 0;
    log('imageMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the the metrics
    //---------------------------------------
    const tasks = chunk(Object.values(ctx.updates), 1000).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', tasks.length);

      const metricInsertColumns = metrics.map((key) => `"${key}" INT[]`).join(', ');
      const metricInsertKeys = metrics.map((key) => `"${key}"`).join(', ');
      const metricValues = metrics
        .map(
          (key) => `
        CASE
          WHEN tf.timeframe = 'Day' THEN COALESCE(d."${key}"[1], im."${key}", 0)
          WHEN tf.timeframe = 'Month' THEN COALESCE(d."${key}"[2], im."${key}", 0)
          WHEN tf.timeframe = 'Week' THEN COALESCE(d."${key}"[3], im."${key}", 0)
          WHEN tf.timeframe = 'Year' THEN COALESCE(d."${key}"[4], im."${key}", 0)
          WHEN tf.timeframe = 'AllTime' THEN COALESCE(d."${key}"[5], im."${key}", 0)
        END as "${key}"
      `
        )
        .join(',\n');
      const metricOverrides = metrics.map((key) => `"${key}" = EXCLUDED."${key}"`).join(',\n');

      await executeRefresh(ctx)`
        -- update image metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("imageId" INT, ${metricInsertColumns}))
        INSERT INTO "ImageMetric" ("imageId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."imageId",
          tf.timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
        LEFT JOIN "ImageMetric" im ON im."imageId" = d."imageId" AND im."timeframe" = tf.timeframe
        WHERE EXISTS (SELECT 1 FROM "Image" WHERE id = d."imageId") -- ensure the image exists
        ON CONFLICT ("imageId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
      `;
      await sleep(1000);
      log('update metrics', i + 1, 'of', tasks.length, 'done');
    });
    await limitConcurrency(tasks, 3);
    // if (hasViewTasks) await setLastViewUpdate();

    // Update the search index
    //---------------------------------------
    // log('update search index');
    // await imagesSearchIndex.queueUpdate(
    //   [...ctx.affected].map((id) => ({
    //     id,
    //     action: SearchIndexUpdateQueueAction.Update,
    //   }))
    // );
    // get me all image metrics that have updated since last

    // Update the age group of the metrics
    //---------------------------------------
    log('update age groups');
    // Fetch things that need to change
    const ageGroupUpdatesQuery = await ctx.pg.cancellableQuery<{ imageId: number }>(`
      SELECT "imageId"
      FROM "ImageMetric"
      WHERE
        ("ageGroup" = 'Year' AND "createdAt" < now() - interval '1 year') OR
        ("ageGroup" = 'Month' AND "createdAt" < now() - interval '1 month') OR
        ("ageGroup" = 'Week' AND "createdAt" < now() - interval '1 week') OR
        ("ageGroup" = 'Day' AND "createdAt" < now() - interval '1 day')
      ORDER BY "imageId";
    `);
    ctx.jobContext.on('cancel', ageGroupUpdatesQuery.cancel);
    const ageGroupUpdates = await ageGroupUpdatesQuery.result();
    const affectedIds = ageGroupUpdates.map((x) => x.imageId);
    if (affectedIds.length) {
      const ageGroupTasks = chunk(affectedIds, 500).map((ids, i) => async () => {
        log('update ageGroups', i + 1, 'of', ageGroupTasks.length);
        await executeRefresh(ctx)`
          UPDATE "ImageMetric"
          SET "ageGroup" = CASE
              WHEN "createdAt" >= now() - interval '1 day' THEN 'Day'::"MetricTimeframe"
              WHEN "createdAt" >= now() - interval '1 week' THEN 'Week'::"MetricTimeframe"
              WHEN "createdAt" >= now() - interval '1 month' THEN 'Month'::"MetricTimeframe"
              WHEN "createdAt" >= now() - interval '1 year' THEN 'Year'::"MetricTimeframe"
              ELSE 'AllTime'::"MetricTimeframe"
          END
          WHERE "imageId" = ANY(${ids}::int[])
            AND "imageId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]};
        `;
        await sleep(2000);
        log('update ageGroups', i + 1, 'of', ageGroupTasks.length, 'done');
      });
      await limitConcurrency(ageGroupTasks, 3);
    }
  },
  async clearDay(ctx) {
    // Clear day of things updated in the last day
    await executeRefresh(ctx)`
      UPDATE "ImageMetric"
        SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  lockTime: 5 * 60,
  updateInterval: 30 * 60,
});

type ImageMetricKey = keyof ImageMetric;
type TimeframeData = [number, number, number, number, number];
type ImageMetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<ImageMetricKey, TimeframeData | number>>;
  lastViewUpdate: Dayjs;
  setLastViewUpdate: () => void;
};
const metrics = [
  'heartCount',
  'likeCount',
  'dislikeCount',
  'laughCount',
  'cryCount',
  'commentCount',
  'collectedCount',
  'tippedCount',
  'tippedAmountCount',
  'viewCount',
] as const;
const timeframeOrder = ['Day', 'Week', 'Month', 'Year', 'AllTime'] as const;

async function getReactionTasks(ctx: ImageMetricContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affected = await getAffected(ctx)`
    -- get recent image reactions
    SELECT
      "imageId" AS id
    FROM "ImageReaction"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    await getMetrics(ctx)`
      -- get image reaction metrics
      SELECT
        r."imageId",
        tf.timeframe,
        ${snippets.reactionTimeframes()}
      FROM "ImageReaction" r
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE r."imageId" IN (${ids})
      GROUP BY r."imageId", tf.timeframe
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

function getMetrics(ctx: ImageMetricContext) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<ImageMetric>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();
    if (!data.length) return;

    for (const row of data) {
      const imageId = row.imageId;
      const { timeframe } = row;
      if (!timeframe) continue;
      const timeframeIndex = timeframeOrder.indexOf(timeframe);
      if (timeframeIndex === -1) continue;

      ctx.updates[imageId] ??= { imageId } as Record<ImageMetricKey, TimeframeData | number>;
      for (const key of Object.keys(row) as ImageMetricKey[]) {
        if (key === 'imageId' || key === 'timeframe') continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[imageId][key] ??= [0, 0, 0, 0, 0];
        (ctx.updates[imageId][key] as TimeframeData)[timeframeIndex] = Number(value);
      }
    }
  });
}

async function getCommentTasks(ctx: ImageMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent image comments
    SELECT t."imageId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."imageId" IS NOT NULL AND c."createdAt" > ${ctx.lastUpdate}
    ORDER BY t."imageId"
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- update image comment metrics
      SELECT
        t."imageId",
        tf.timeframe,
        ${snippets.timeframeSum('c."createdAt"')} "commentCount"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE t."imageId" IN (${ids})
        AND t."imageId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."imageId", tf.timeframe
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: ImageMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent image collections
    SELECT "imageId" as id
    FROM "CollectionItem"
    WHERE "imageId" IS NOT NULL AND "createdAt" > ${ctx.lastUpdate}
    ORDER BY "imageId"
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- update image collection metrics
      SELECT
        "imageId",
        tf.timeframe,
        ${snippets.timeframeSum('ci."createdAt"')} "collectedCount"
      FROM "CollectionItem" ci
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE ci."imageId" IN (${ids})
        AND ci."imageId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY ci."imageId", tf.timeframe
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: ImageMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent image tips
    SELECT DISTINCT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'Image' AND ("createdAt" > ${ctx.lastUpdate} OR "updatedAt" > ${ctx.lastUpdate})
    ORDER BY "entityId"
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- update image tip metrics
      SELECT
        "entityId" as "imageId",
        tf.timeframe,
        ${snippets.timeframeSum('bt."updatedAt"')} "tippedCount",
        ${snippets.timeframeSum('bt."updatedAt"', 'amount')} "tippedAmountCount"
      FROM "BuzzTip" bt
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE "entityId" IN (${ids}) AND "entityType" = 'Image'
        AND "entityId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY "entityId", tf.timeframe
    `;
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type ImageMetricView = {
  imageId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
async function getViewTasks(ctx: ImageMetricContext) {
  if (ctx.lastViewUpdate.isAfter(ctx.lastViewUpdate.subtract(1, 'day'))) return [];

  const viewed = await ctx.ch.$query<ImageMetricView>`
    WITH targets AS (
      SELECT
        entityId
      FROM views
      WHERE entityType = 'Image'
      AND time >= ${ctx.lastUpdate}
    )
    SELECT
      entityId AS imageId,
      sumIf(views, createdDate = current_date()) day,
      sumIf(views, createdDate >= subtractDays(current_date(), 7)) week,
      sumIf(views, createdDate >= subtractDays(current_date(), 30)) month,
      sumIf(views, createdDate >= subtractYears(current_date(), 1)) year,
      sum(views) all_time
    FROM daily_views
    WHERE entityId IN (select entityId FROM targets)
      AND entityType = 'Image'
    GROUP BY imageId;
  `;
  ctx.addAffected(viewed.map((x) => x.imageId));

  const tasks = chunk(viewed, 1000).map((batch, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getViewTasks', i + 1, 'of', tasks.length);
    for (const row of batch) {
      const { imageId, ...views } = row;
      if (!imageId) continue;
      const viewCount = Object.values(views).reduce((a, b) => a + b, 0);
      if (viewCount === 0) continue;
      ctx.updates[imageId] ??= { imageId } as Record<ImageMetricKey, TimeframeData | number>;
      ctx.updates[imageId].viewCount = [
        views.day,
        views.week,
        views.month,
        views.year,
        views.all_time,
      ];
    }
    log('getViewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
