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
      getReactionTasks(ctx),
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

type TimeframeRow = {
  userId: number;
  day: number;
  week: number;
  month: number;
  year: number;
  all_time: number;
};
const reactionTypes = `('Image_Create', 'Comment_Create', 'CommentV2_Create', 'Review_Create', 'Question_Create', 'Answer_Create', 'BountyEntry_Create', 'Article_Create')`;
async function getReactionTasks(ctx: MetricProcessorRunContext) {
  const data = await ctx.ch.$query<TimeframeRow>`
    WITH targets AS (
      SELECT
        ownerId
      FROM reactions
      WHERE time > parseDateTimeBestEffort('${ctx.lastUpdate}')
    )
    SELECT
      ownerId as userId,
      SUM(CASE
        WHEN createdDate < current_date() THEN 0
        WHEN type IN ${reactionTypes} THEN 1
        ELSE -1
      END) as day,
      SUM(CASE
        WHEN createdDate < subtractDays(current_date(),7) THEN 0
        WHEN type IN ${reactionTypes} THEN 1
        ELSE -1
      END) as week,
      SUM(CASE
        WHEN createdDate < subtractMonths(current_date(), 1) THEN 0
        WHEN type IN ${reactionTypes} THEN 1
        ELSE -1
      END) as month,
      SUM(CASE
        WHEN createdDate < subtractYears(current_date(), 1) THEN 0
        WHEN type IN ${reactionTypes} THEN 1
        ELSE -1
      END) as year,
      SUM(CASE
        WHEN type IN ${reactionTypes} THEN 1
        ELSE -1
      END) as all_time
    FROM reactions
    WHERE (time < parseDateTimeBestEffort('2024-04-27') OR userId != ownerId)
      AND ownerId IN (SELECT ownerId FROM targets)
    GROUP BY 1;
  `;

  const tasks = chunk(data, 1000).map((rows, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);
    const json = JSON.stringify(rows);
    await executeRefresh(ctx)`
      INSERT INTO "UserMetric" ("userId", timeframe, "reactionCount")
      SELECT
          um."userId", um.timeframe, um."reactionCount"
      FROM
      (
        SELECT
          CAST(data::json->>'userId' AS INT) AS "userId",
          tf.timeframe,
          CAST(
            CASE
              WHEN tf.timeframe = 'Day' THEN data::json->>'day'
              WHEN tf.timeframe = 'Week' THEN data::json->>'week'
              WHEN tf.timeframe = 'Month' THEN data::json->>'month'
              WHEN tf.timeframe = 'Year' THEN data::json->>'year'
              WHEN tf.timeframe = 'AllTime' THEN data::json->>'all_time'
            END
          AS int) as "reactionCount"
        FROM json_array_elements('${json}'::json) data
        CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
        ) tf
      ) um
      WHERE um."reactionCount" IS NOT NULL
        AND um."userId" IN (SELECT id FROM "User")
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "reactionCount" = EXCLUDED."reactionCount", "updatedAt" = now();
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
