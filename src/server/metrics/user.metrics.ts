import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { usersSearchIndex } from '~/server/search-index';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  executeRefresh,
  executeRefreshWithParams,
  getAffected,
} from '~/server/metrics/metric-helpers';
import { chunk } from 'lodash-es';

const log = createLogger('metrics:user');

const metrics = [
  'followerCount',
  'followingCount',
  'hiddenCount',
  'uploadCount',
  'reviewCount',
  'reactionCount',
] as const;

type MetricKey = (typeof metrics)[number];
type UserMetricContext = MetricProcessorRunContext & {
  updates: Record<number, Partial<Record<MetricKey, number>> & { userId: number }>;
};

export const userMetrics = createMetricProcessor({
  name: 'User',
  async update(baseCtx) {
    // Update the context to include the update record
    const ctx = baseCtx as UserMetricContext;
    ctx.updates = {};

    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getEngagementTasks(ctx),
      getFollowingTasks(ctx),
      getModelTasks(ctx),
      getReviewTasks(ctx),
      getReactionTasks(ctx),
    ]);
    log('userMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the user metrics
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

      await executeRefreshWithParams(
        ctx,
        `-- update user metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("userId" INT, ${metricInsertColumns}))
        INSERT INTO "UserMetric" ("userId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."userId",
          'AllTime'::"MetricTimeframe" AS timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "UserMetric" im ON im."userId" = d."userId" AND im."timeframe" = 'AllTime'
        WHERE EXISTS (SELECT 1 FROM "User" WHERE id = d."userId")
        ON CONFLICT ("userId", "timeframe") DO UPDATE
          SET
            ${metricOverrides},
            "updatedAt" = NOW()`,
        [JSON.stringify(batch)]
      );
      log('update metrics', i + 1, 'of', updateTasks.length, 'done');
    });
    await limitConcurrency(updateTasks, 10);

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
  // Not using day metrics anymore
  // async clearDay(ctx) {
  //   await executeRefresh(ctx)`
  //     UPDATE "UserMetric"
  //       SET "followerCount" = 0, "followingCount" = 0, "hiddenCount" = 0, "uploadCount" = 0, "reviewCount" = 0, "answerCount" = 0, "answerAcceptCount" = 0
  //     WHERE timeframe = 'Day'
  //       AND "updatedAt" > date_trunc('day', now() - interval '1 day');
  //   `;
  // },
  // rank: {
  //   table: 'UserRank',
  //   primaryKey: 'userId',
  //   indexes: ['leaderboardRank'],
  //   refreshInterval: 1000 * 60 * 60 * 24, // 24 hours
  // },
});

async function getMetrics(ctx: UserMetricContext, sql: string, params: any[] = []) {
  const query = await ctx.pg.cancellableQuery<{ userId: number } & Record<string, string | number>>(
    sql,
    params
  );
  ctx.jobContext.on('cancel', query.cancel);
  const data = await query.result();
  if (!data.length) return;

  for (const row of data) {
    const userId = row.userId;
    ctx.updates[userId] ??= { userId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === 'userId' || key === 'timeframe') continue;
      const value = row[key];
      if (value == null) continue;
      (ctx.updates[userId] as any)[key] = typeof value === 'string' ? parseInt(value) : value;
    }
  }
}

async function getEngagementTasks(ctx: UserMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent user engagements
    SELECT
      "targetUserId" as id
    FROM "UserEngagement"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get user engagement metrics
      SELECT
        "targetUserId" as "userId",
        SUM(CASE WHEN type = 'Follow' THEN 1 ELSE 0 END)::int as "followerCount",
        SUM(CASE WHEN type = 'Hide' THEN 1 ELSE 0 END)::int as "hiddenCount"
      FROM "UserEngagement"
      WHERE "targetUserId" = ANY($1::int[])
      GROUP BY "targetUserId"`,
      [ids]
    );

    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getFollowingTasks(ctx: UserMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent user engagements
    SELECT
      "userId" as id
    FROM "UserEngagement"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getFollowingTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get user following metrics
      SELECT
        "userId",
        SUM(CASE WHEN type = 'Follow' THEN 1 ELSE 0 END)::int as "followingCount"
      FROM "UserEngagement"
      WHERE "userId" = ANY($1::int[])
      GROUP BY "userId"`,
      [ids]
    );

    log('getFollowingTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getModelTasks(ctx: UserMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent user published models
    SELECT
      m."userId" as id
    FROM "ModelVersion" mv
    JOIN "Model" m ON mv."modelId" = m.id
    WHERE (mv."publishedAt" > ${ctx.lastUpdate} AND mv."status" = 'Published')
      OR (mv."publishedAt" <= ${ctx.lastUpdate} AND mv."status" = 'Scheduled')
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getModelTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get user upload metrics
      SELECT
        m."userId",
        COUNT(*)::int as "uploadCount"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE m."userId" = ANY($1::int[])
        AND (
          mv."status" = 'Published'
          OR (mv."publishedAt" <= $2 AND mv."status" = 'Scheduled')
        )
      GROUP BY m."userId"`,
      [ids, ctx.lastUpdate]
    );

    log('getModelTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getReviewTasks(ctx: UserMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent user reviews
    SELECT
      "userId" as id
    FROM "ResourceReview"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReviewTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get user review metrics
      SELECT
        rr."userId",
        COUNT(*)::int as "reviewCount"
      FROM "ResourceReview" rr
      JOIN "ModelVersion" mv on rr."modelVersionId" = mv.id
      WHERE rr."userId" = ANY($1::int[])
        AND mv.status = 'Published'
      GROUP BY rr."userId"`,
      [ids]
    );

    log('getReviewTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

type TimeframeRow = {
  userId: number;
  all_time: number;
};
async function getReactionTasks(ctx: UserMetricContext) {
  const data = await ctx.ch.$query<TimeframeRow>`
    WITH targets AS (
        SELECT DISTINCT ownerId
        FROM reactions
        WHERE time > ${ctx.lastUpdate}
    )
    SELECT
        ownerId as userId,
        sum(score) as all_time
    FROM reactions_owner_scores
    WHERE ownerId IN (SELECT ownerId FROM targets)
    GROUP BY 1;
  `;

  const tasks = chunk(data, 1000).map((rows, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    for (const row of rows) {
      const userId = row.userId;
      ctx.updates[userId] ??= { userId };
      ctx.updates[userId].reactionCount = row.all_time;
    }

    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
