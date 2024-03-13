import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { usersSearchIndex } from '~/server/search-index';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { chunk } from 'lodash-es';

const log = createLogger('metrics:user');

export const userMetrics = createMetricProcessor({
  name: 'User',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getEngagementTasks(ctx),
      getFollowingTasks(ctx),
      getModelTasks(ctx),
      getReviewTasks(ctx),
    ]);
    log('userMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await usersSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  },
  async clearDay(ctx) {
    await executeRefresh(ctx)`
      UPDATE "UserMetric"
        SET "followerCount" = 0, "followingCount" = 0, "hiddenCount" = 0, "uploadCount" = 0, "reviewCount" = 0, "answerCount" = 0, "answerAcceptCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'UserRank',
    primaryKey: 'userId',
    indexes: ['leaderboardRank'],
    refreshInterval: 1000 * 60 * 60 * 24, // 24 hours
  },
});

async function getEngagementTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent user engagements
    SELECT
      "targetUserId" as id
    FROM "UserEngagement"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update tag engagement metrics
      INSERT INTO "UserMetric" ("userId", timeframe, "followerCount", "hiddenCount")
      SELECT
        "targetUserId",
        tf.timeframe,
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Follow'`)} "followerCount",
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Hide'`)} "hiddenCount"
      FROM "UserEngagement" e
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "targetUserId" IN (${ids})
      GROUP BY "targetUserId", tf.timeframe
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "hiddenCount" = EXCLUDED."hiddenCount", "updatedAt" = NOW()
    `;
    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getFollowingTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent user engagements
    SELECT
      "userId" as id
    FROM "UserEngagement"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update tag engagement metrics
      INSERT INTO "UserMetric" ("userId", timeframe, "followingCount")
      SELECT
        "userId",
        tf.timeframe,
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Follow'`)} "followingCount"
      FROM "UserEngagement" e
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "userId" IN (${ids})
      GROUP BY "userId", tf.timeframe
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "followingCount" = EXCLUDED."followingCount", "updatedAt" = NOW()
    `;
    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getModelTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent user published models
    SELECT
      m."userId" as id
    FROM "ModelVersion" mv
    JOIN "Model" m ON mv."modelId" = m.id
    WHERE (mv."publishedAt" > '${ctx.lastUpdate}' AND mv."status" = 'Published')
      OR (mv."publishedAt" <= '${ctx.lastUpdate}' AND mv."status" = 'Scheduled')
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getModelTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update published model user metrics
      INSERT INTO "UserMetric" ("userId", timeframe, "uploadCount")
      SELECT
        "userId",
        tf.timeframe,
        ${snippets.timeframeSum('mv."publishedAt"')} "uploadCount"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "userId" IN (${ids})
        AND (
          (mv."publishedAt" > '${ctx.lastUpdate}' AND mv."status" = 'Published')
          OR (mv."publishedAt" <= '${ctx.lastUpdate}' AND mv."status" = 'Scheduled')
        )
      GROUP BY "userId", tf.timeframe
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "uploadCount" = EXCLUDED."uploadCount", "updatedAt" = NOW()
    `;
    log('getModelTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getReviewTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent user reviews
    SELECT
      "userId" as id
    FROM "ResourceReview"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReviewTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update user review metrics
      INSERT INTO "UserMetric" ("userId", timeframe, "reviewCount")
      SELECT
        "userId",
        tf.timeframe,
        ${snippets.timeframeSum('rr."createdAt"')} "reviewCount"
      FROM "ResourceReview" rr
      JOIN "ModelVersion" mv on rr."modelVersionId" = mv.id
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "userId" IN (${ids})
        AND mv.status = 'Published'
      GROUP BY "userId", tf.timeframe
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "reviewCount" = EXCLUDED."reviewCount", "updatedAt" = NOW()
    `;
    log('getReviewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
