import { chunk } from 'lodash-es';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { limitConcurrency, sleep, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { PostMetric } from '~/shared/utils/prisma/models';
import dayjs from 'dayjs';
import { templateHandler } from '~/server/db/db-helpers';
import { isDefined } from '~/utils/type-guards';

const log = createLogger('metrics:post');

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

      const batchJson = JSON.stringify(batch);
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
        WITH data AS (SELECT * FROM jsonb_to_recordset('${batchJson}') AS x("postId" INT, ${metricInsertColumns}))
        INSERT INTO "PostMetric" ("postId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."postId",
          tf.timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS "timeframe") tf
        LEFT JOIN "PostMetric" im ON im."postId" = d."postId" AND im."timeframe" = tf.timeframe
        WHERE EXISTS (SELECT 1 FROM "Post" WHERE id = d."postId") -- ensure the post exists
        ON CONFLICT ("postId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
      `;
      // await sleep(1000);
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

    // Update the age groups
    //---------------------------------------
    const ageGroupUpdatesQuery = await ctx.pg.cancellableQuery<{ postId: number }>(`
      SELECT "postId"
      FROM "PostMetric" pm
      JOIN "Post" p ON p.id = pm."postId"
      WHERE
        (p."publishedAt" IS NULL AND "ageGroup" IS NOT NULL) OR
        ("ageGroup" IS NULL AND p."publishedAt" IS NOT NULL) OR
        ("ageGroup" IS NOT NULL AND p."publishedAt" > now()) OR
        ("ageGroup" = 'Year' AND p."publishedAt" < now() - interval '1 year') OR
        ("ageGroup" = 'Month' AND p."publishedAt" < now() - interval '1 month') OR
        ("ageGroup" = 'Week' AND p."publishedAt" < now() - interval '1 week') OR
        ("ageGroup" = 'Day' AND p."publishedAt" < now() - interval '1 day')
    `);
    ctx.jobContext.on('cancel', ageGroupUpdatesQuery.cancel);
    const ageGroupUpdates = await ageGroupUpdatesQuery.result();
    const affectedIds = ageGroupUpdates.map((x) => x.postId);
    if (affectedIds.length) {
      const ageGroupTasks = chunk(affectedIds, 500).map((ids, i) => async () => {
        log('update ageGroups', i + 1, 'of', ageGroupTasks.length);
        await executeRefresh(ctx)`
          UPDATE "PostMetric" pm
          SET "ageGroup" = CASE
              WHEN p."publishedAt" IS NULL THEN NULL
              WHEN p."publishedAt" > now() THEN NULL -- future posts
              WHEN p."publishedAt" >= now() - interval '1 day' THEN 'Day'::"MetricTimeframe"
              WHEN p."publishedAt" >= now() - interval '1 week' THEN 'Week'::"MetricTimeframe"
              WHEN p."publishedAt" >= now() - interval '1 month' THEN 'Month'::"MetricTimeframe"
              WHEN p."publishedAt" >= now() - interval '1 year' THEN 'Year'::"MetricTimeframe"
              ELSE 'AllTime'::"MetricTimeframe"
          END
          FROM "Post" p
          WHERE pm."postId" = p.id
            AND pm."postId" IN (${ids})
            AND pm."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
        `;
        // await sleep(2000);
        log('update ageGroups', i + 1, 'of', ageGroupTasks.length, 'done');
      });
      await limitConcurrency(ageGroupTasks, 10);
    }
  },
  async clearDay(ctx) {
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
        AND createdAt > ${ctx.lastUpdate};
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
      WHERE i.id IN (${ids})
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
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE i."postId" IN (${ids})
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
    WHERE t."postId" IS NOT NULL AND c."createdAt" > '${ctx.lastUpdate}'
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
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
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
    WHERE "postId" IS NOT NULL AND "createdAt" > '${ctx.lastUpdate}'
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
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
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
  lastViewUpdate: dayjs.Dayjs;
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
