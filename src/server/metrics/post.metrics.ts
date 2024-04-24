import { chunk } from 'lodash-es';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:post');

export const postMetrics = createMetricProcessor({
  name: 'Post',
  async update(ctx) {
    const tasks = (await Promise.all([
      getReactionTasks(ctx),
      getCommentTasks(ctx),
      getCollectionTasks(ctx),
    ]).then((x) => x.flat())) as Task[];
    log('postMetrics update', tasks.length, 'tasks');
    await limitConcurrency(tasks, 5);
  },
  async clearDay(ctx) {
    log('clearDay');
    await executeRefresh(ctx)`
      UPDATE "PostMetric"
        SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "collectedCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'PostRank',
    primaryKey: 'postId',
    indexes: [
      'reactionCountAllTimeRank',
      'reactionCountDayRank',
      'reactionCountWeekRank',
      'reactionCountMonthRank',
      'reactionCountYearRank',
      'commentCountAllTimeRank',
      'commentCountDayRank',
      'commentCountWeekRank',
      'commentCountMonthRank',
      'commentCountYearRank',
      'collectedCountAllTimeRank',
      'collectedCountDayRank',
      'collectedCountWeekRank',
      'collectedCountMonthRank',
      'collectedCountYearRank',
    ],
  },
});

async function getReactionTasks(ctx: MetricProcessorRunContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affected = await getAffected(ctx)`
    -- get recent post image reactions
    SELECT DISTINCT
      i."postId" AS id
    FROM "ImageReaction" ir
    JOIN "Image" i ON i.id = ir."imageId"
    WHERE ir."createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update post reaction metrics
      INSERT INTO "PostMetric" ("postId", timeframe, ${snippets.reactionMetricNames})
      SELECT
        i."postId",
        tf.timeframe,
        ${snippets.reactionTimeframes()}
      FROM "ImageReaction" r
      JOIN "Image" i ON i.id = r."imageId"
      JOIN "Post" p ON p.id = i."postId" -- Make sure it exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE i."postId" IN (${ids})
      GROUP BY i."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET ${snippets.reactionMetricUpserts}, "updatedAt" = NOW()
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricProcessorRunContext) {
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
    await executeRefresh(ctx)`
      -- update post comment counts
      INSERT INTO "PostMetric" ("postId", timeframe, "commentCount")
      SELECT
        t."postId",
        tf.timeframe,
        ${snippets.timeframeSum('c."createdAt"')}
      FROM "Thread" t
      JOIN "CommentV2" c ON t."id" = c."threadId"
      JOIN "Post" p ON p.id = t."postId" -- Make sure it exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE t."postId" IS NOT NULL AND t."postId" IN (${ids})
      GROUP BY t."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "createdAt" = NOW()
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCollectionTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent post collections
    SELECT DISTINCT
      "postId" AS id
    FROM "CollectionItem"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCollectionTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update post collection counts
      INSERT INTO "PostMetric" ("postId", timeframe, "collectedCount")
      SELECT
        ci."postId",
        tf.timeframe,
        ${snippets.timeframeSum('ci."createdAt"')}
      FROM "CollectionItem" ci
      JOIN "Post" p ON p.id = ci."postId" -- Make sure it exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE ci."postId" IS NOT NULL AND ci."postId" IN (${ids})
      GROUP BY ci."postId", tf.timeframe
      ON CONFLICT ("postId", timeframe) DO UPDATE
        SET "collectedCount" = EXCLUDED."collectedCount", "createdAt" = NOW()
    `;
    log('getCollectionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
