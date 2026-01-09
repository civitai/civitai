import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected } from '~/server/metrics/metric-helpers';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import type { PostMetric } from '~/shared/utils/prisma/models';
import { templateHandler } from '~/server/db/db-helpers';
import { isDefined } from '~/utils/type-guards';
import { postStatCache } from '~/server/redis/caches';
import { isFlipt } from '~/server/flipt/client';
import { update } from '~/server/metrics/post.metrics-old';

const log = createLogger('metrics:post');

export const postMetrics = createMetricProcessor({
  name: 'Post',
  async update(baseCtx) {
    const useSimplifiedMetrics = await isFlipt('simplified-post-metrics');
    if (!useSimplifiedMetrics) return update(baseCtx);

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
    const metricInsertColumns = metrics.map((key) => `"${key}" INT`).join(', ');
    const metricInsertKeys = metrics.map((key) => `"${key}"`).join(', ');
    const metricValues = metrics
      .map((key) => `COALESCE(d."${key}", im."${key}", 0) as "${key}"`)
      .join(',\n');
    const metricOverrides = metrics.map((key) => `"${key}" = EXCLUDED."${key}"`).join(',\n');

    const updateTasks = chunk(Object.values(ctx.updates), 100).map((batch, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log('update metrics', i + 1, 'of', updateTasks.length);
      await executeRefresh(ctx)`
        -- update post metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x("postId" INT, ${metricInsertColumns}))
        INSERT INTO "PostMetric" ("postId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."postId",
          'AllTime'::"MetricTimeframe" AS timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "PostMetric" im ON im."postId" = d."postId" AND im."timeframe" = 'AllTime'
        WHERE EXISTS (SELECT 1 FROM "Post" WHERE id = d."postId") -- ensure the post exists
        ON CONFLICT ("postId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()
      `;
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

    // Bust post stat cache for all affected posts
    //---------------------------------------
    const affectedPostIds = Object.keys(ctx.updates).map((id) => parseInt(id, 10));
    log('bust post stat cache', affectedPostIds.length, 'posts');
    if (affectedPostIds.length > 0) {
      await postStatCache.bust(affectedPostIds);
    }
  },
  // Not using day metrics anymore
  // async clearDay() {
  //   await executeRefresh(ctx)`
  //     UPDATE "PostMetric"
  //       SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0
  //     WHERE timeframe = 'Day'
  //       AND "updatedAt" > date_trunc('day', now() - interval '1 day');
  //   `;
  // },
});

async function getReactionTasks(ctx: MetricContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affectedImages = await ctx.ch.$query<{ imageId: number }>`
      SELECT DISTINCT entityId as imageId
      FROM entityMetricDailyAgg
      WHERE entityType = 'Image'
        AND entityId IS NOT NULL
        AND day >= toDate(${ctx.lastUpdate})
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
        'AllTime'::"MetricTimeframe" AS timeframe,
        SUM(CASE WHEN r.reaction = 'Heart' THEN 1 ELSE 0 END)::int AS "heartCount",
        SUM(CASE WHEN r.reaction = 'Like' THEN 1 ELSE 0 END)::int AS "likeCount",
        SUM(CASE WHEN r.reaction = 'Dislike' THEN 1 ELSE 0 END)::int AS "dislikeCount",
        SUM(CASE WHEN r.reaction = 'Laugh' THEN 1 ELSE 0 END)::int AS "laughCount",
        SUM(CASE WHEN r.reaction = 'Cry' THEN 1 ELSE 0 END)::int AS "cryCount"
      FROM "ImageReaction" r
      JOIN "Image" i ON i.id = r."imageId"
      WHERE i."postId" IN (${ids})
        AND i."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY i."postId"
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
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(c.id)::int AS "commentCount"
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."postId" IN (${ids})
        AND t."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."postId"
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
        'AllTime'::"MetricTimeframe" AS timeframe,
        COUNT(ci.id)::int AS "collectedCount"
      FROM "CollectionItem" ci
      WHERE ci."postId" IN (${ids})
        AND ci."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY ci."postId"
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type MetricKey = keyof PostMetric;
type MetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<MetricKey, number>>;
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

function getMetrics(ctx: MetricContext) {
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery<PostMetric>(sql);
    ctx.jobContext.on('cancel', query.cancel);
    const data = await query.result();
    if (!data.length) return;

    for (const row of data) {
      const postId = row.postId;
      ctx.updates[postId] ??= { postId } as Record<MetricKey, number>;
      for (const key of Object.keys(row) as MetricKey[]) {
        if (key === 'postId' || key === 'timeframe') continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[postId][key] = Number(value);
      }
    }
  });
}
