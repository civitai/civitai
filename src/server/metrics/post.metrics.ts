import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import {
  executeRefresh,
  getAffected,
  getEntityMetricTasks,
  reactionCountKeys,
  snippets,
} from '~/server/metrics/metric-helpers';
import { getMetricExcludedUserIdsOrThrow } from '~/server/services/metric-excluded-users.service';
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
    ctx.idKey = 'postId';

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

// Exported for the SQL-shape test: nothing in the suite executes these queries, so the
// only way to assert the filter reaches the statement is to capture what is sent.
export async function getReactionTasks(ctx: MetricContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const excludedFilter = snippets.excludedReactorFilter(await getMetricExcludedUserIdsOrThrow());
  const affectedImages = await ctx.ch.$query<{ imageId: number }>`
    -- get recent images with reactions
    SELECT DISTINCT entityId as imageId
    FROM entityMetricEvents_month
    WHERE entityType = 'Image'
    AND metricType IN ('Like', 'Heart', 'Laugh', 'Cry')
    AND createdAt > ${ctx.lastUpdate};
  `;

  const affected = new Set<number>();
  // Sorted for the same reason the post chunk below is: the query bounds each chunk with
  // `BETWEEN ids[0] AND ids[ids.length - 1]`, and the ClickHouse query above has no
  // ORDER BY, so an unsorted chunk whose first id exceeds its last matches nothing and
  // those images never become affected posts. Sorted here rather than in ClickHouse so a
  // future edit to that query cannot quietly re-break it.
  const postFetchTasks = chunk(
    affectedImages.map((x) => x.imageId).sort((a, b) => a - b),
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

  // Sorted because the query below bounds the chunk with
  // `BETWEEN ids[0] AND ids[ids.length - 1]`. `affected` is a Set in insertion order, so
  // an unsorted chunk whose first id exceeds its last matches NOTHING — and with the
  // zero-seeding below, a chunk that matches nothing would write zeros over real counts.
  const tasks = chunk(
    [...affected].sort((a, b) => a - b),
    100
  ).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    // An entity whose remaining reactions are all excluded yields NO ROW from the
    // aggregate below, and a missing row means "no change" to every writer downstream —
    // so the pre-exclusion total would survive even a full recompute. Seeding zeros
    // first makes the absence of a row mean zero; the aggregate overwrites whatever it
    // does return.
    for (const id of ids) {
      const row = (ctx.updates[id] ??= { [ctx.idKey]: id });
      for (const key of reactionCountKeys) row[key] ??= 0;
    }
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
        ${excludedFilter}
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
      JOIN "CommentV2" c ON c."threadId" = t.id AND c."tosViolation" = false
      WHERE t."postId" IN (${ids})
        AND t."postId" BETWEEN ${ids[0]} AND ${ids[ids.length - 1]}
      GROUP BY t."postId"
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricContext) {
  return getEntityMetricTasks(ctx)('Post', 'collectedCount');
}

type MetricKey = keyof PostMetric;
export type MetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<string, number>>;
  idKey: string;
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
      const entityId = row.postId;
      ctx.updates[entityId] ??= { [ctx.idKey]: entityId };
      for (const key of Object.keys(row) as MetricKey[]) {
        if (key === ctx.idKey || key === 'timeframe') continue;
        const value = row[key];
        if (value == null) continue;
        ctx.updates[entityId][key] = Number(value);
      }
    }
  });
}
