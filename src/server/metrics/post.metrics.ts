import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import type { PostMetric } from '~/shared/utils/prisma/models';
import dayjs from '~/shared/utils/dayjs';
import { templateHandler } from '~/server/db/db-helpers';
import { isDefined } from '~/utils/type-guards';
import { getJobDate } from '~/server/jobs/job';
import { capitalize } from '~/utils/string-helpers';
import type { Dayjs } from 'dayjs';

const log = createLogger('metrics:post');

const timePeriods = ['now', 'day', 'week', 'month', 'year', 'allTime'] as const;

export const postMetrics = createMetricProcessor({
  name: 'Post',
  async update(baseCtx) {
    // Update the context to include the update record
    const ctx = baseCtx as MetricContext;
    ctx.updates = {};

    // Get the metric tasks
    //---------------------------------------
    const fetchTasks = (await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
    ]).then((x) => x.flat())) as Task[];
    log('postMetrics update', fetchTasks.length, 'tasks');
    await limitConcurrency(fetchTasks, 5);

    // Update the post metrics
    //---------------------------------------
    const updateTasks = chunk(Object.values(ctx.updates), 1000).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', updateTasks.length);

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
        -- update post metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("postId" INT, ${metricInsertColumns}))
        INSERT INTO "PostMetric" ("postId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."postId",
          tf.timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
        LEFT JOIN "PostMetric" im ON im."postId" = d."postId" AND im."timeframe" = tf.timeframe
        WHERE EXISTS (SELECT 1 FROM "Post" WHERE id = d."postId") -- ensure the post exists
        ON CONFLICT ("postId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
      `;
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

    // Update the age groups
    //---------------------------------------
    // Keep track of the last time the age group job was run
    const [ageGroupLastRun, setAgeGroupLastRun] = await getJobDate(
      'metric:post:ageGroup',
      new Date()
    );
    await setAgeGroupLastRun();
    const lastRunStart = ageGroupLastRun.valueOf();

    for (const timePeriod of timePeriods) {
      if (timePeriod === 'allTime') continue;

      const windowDuration = lastRunStart - ctx.lastUpdate.valueOf();
      const windowEnd =
        timePeriod === 'now'
          ? dayjs(lastRunStart).valueOf()
          : dayjs(lastRunStart).subtract(1, timePeriod).valueOf();
      const windowStart =
        timePeriod === 'now'
          ? dayjs(windowEnd).subtract(1, 'day').valueOf() - windowDuration
          : windowEnd - windowDuration;

      // Fetch affected posts between the timeframe
      const affectedPostIdsQuery = await ctx.pg.cancellableQuery<{ id: number }>(`
        SELECT
          id
        FROM "Post" WHERE "publishedAt" BETWEEN '${new Date(
          windowStart
        ).toISOString()}' AND '${new Date(windowEnd).toISOString()}'
        ORDER BY id;
      `);

      const affectedPostIds = await affectedPostIdsQuery.result();
      const affectedIds = affectedPostIds.map((x) => x.id);
      if (!affectedIds.length) continue;

      // Roll over affected posts to next ageGroup period
      const periodIndex = timePeriods.indexOf(timePeriod);
      if (periodIndex === -1) continue;

      const ageGroupTasks = chunk(affectedIds, 10000).map((ids, i) => async () => {
        log('update ageGroups', timePeriod, i + 1, 'of', ageGroupTasks.length);
        await executeRefresh(ctx)`
          UPDATE "PostMetric" pm
          SET "ageGroup" = '${capitalize(timePeriods[periodIndex + 1])}'::"MetricTimeframe"
          WHERE pm."postId" = ANY(${ids}::int[])
            AND pm."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        `;
        log('update ageGroups', timePeriod, i + 1, 'of', ageGroupTasks.length, 'done');
      });

      await limitConcurrency(ageGroupTasks, 10);
    }
  },
  async clearDay() {
    // No longer needed based on what Justin said
    // log('clearDay');
    // await executeRefresh(ctx)`
    //   UPDATE "PostMetric"
    //     SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0
    //   WHERE timeframe = 'Day'
    //     AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    // `;
  },
});

async function getReactionTasks(ctx: MetricContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affectedImages = await ctx.ch.$query<{ imageId: number }>`
      SELECT DISTINCT entityId as imageId
      FROM entityMetricEvents
      WHERE entityType = 'Image'
        AND entityId IS NOT NULL
        AND createdAt > ${ctx.lastUpdate}
      ORDER BY entityId ASC;
  `;

  const affected = new Set<number>();
  const postFetchTasks = chunk(
    affectedImages.map((x) => x.imageId),
    30000
  ).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionPosts', i + 1, 'of', postFetchTasks.length);

    const postIds = await getAffected(ctx)`
      -- get recent post image reactions
      SELECT DISTINCT
        i."postId" AS id
      FROM "Image" i
      WHERE i.id = ANY(${ids}::int[])
        AND i.id BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
    `;
    postIds.filter(isDefined).forEach((x) => affected.add(x));
    log('getReactionPosts', i + 1, 'of', postFetchTasks.length, 'done');
  });
  await limitConcurrency(postFetchTasks, 3);

  const tasks = chunk([...affected], 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get post reaction metrics
      SELECT
        i."postId",
        tf.timeframe,
        ${snippets.reactionTimeframes()}
      FROM "ImageReaction" r
      JOIN "Image" i ON i.id = r."imageId"
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE i."postId" IN (${ids})
        AND i."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY i."postId", tf.timeframe
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent post comments
    SELECT DISTINCT
      t."postId" AS id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."postId" IS NOT NULL AND c."createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get post comment metrics
      SELECT
        t."postId",
        tf.timeframe,
        ${snippets.timeframeSum('c."createdAt"')} "commentCount"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE t."postId" IN (${ids})
        AND t."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."postId", tf.timeframe
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent post collections
    SELECT DISTINCT
      "postId" AS id
    FROM "CollectionItem"
    WHERE "postId" IS NOT NULL AND "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await getMetrics(ctx)`
      -- get post collection metrics
      SELECT
        ci."postId",
        tf.timeframe,
        ${snippets.timeframeSum('ci."createdAt"')} "collectedCount"
      FROM "CollectionItem" ci
      CROSS JOIN (SELECT unnest(enum_range('AllTime'::"MetricTimeframe", NULL)) AS "timeframe") tf
      WHERE ci."postId" IN (${ids})
        AND ci."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY ci."postId", tf.timeframe
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type MetricKey = keyof PostMetric;
type TimeframeData = [number, number, number, number, number];
type MetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<MetricKey, TimeframeData | number>>;
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
] as const;
const timeframeOrder = ['Day', 'Week', 'Month', 'Year', 'AllTime'] as const;

function getMetrics(ctx: MetricContext) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<PostMetric>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();
    if (!data.length) return;

    for (const row of data) {
      const postId = row.postId;
      const { timeframe } = row;
      if (!timeframe) continue;
      const timeframeIndex = timeframeOrder.indexOf(timeframe);
      if (timeframeIndex === -1) continue;

      ctx.updates[postId] ??= { postId } as Record<MetricKey, TimeframeData | number>;
      for (const key of Object.keys(row) as MetricKey[]) {
        if (key === 'postId' || key === 'timeframe') continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[postId][key] ??= [0, 0, 0, 0, 0];
        (ctx.updates[postId][key] as TimeframeData)[timeframeIndex] = Number(value);
      }
    }
  });
}
