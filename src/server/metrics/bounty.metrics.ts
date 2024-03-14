import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { bountiesSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:bounty');

export const bountyMetrics = createMetricProcessor({
  name: 'Bounty',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getEngagementTasks(ctx),
      getCommentTasks(ctx),
      getBenefactorTasks(ctx),
      getEntryTasks(ctx),
    ]);
    log('imageMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await bountiesSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  },
  async clearDay(ctx) {
    await executeRefresh(ctx)`
      UPDATE "BountyMetric"
        SET "favoriteCount" = 0, "trackCount" = 0, "entryCount" = 0, "benefactorCount" = 0, "unitAmountCount" = 0, "commentCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'BountyRank',
    primaryKey: 'bountyId',
    refreshInterval: 5 * 60 * 1000,
  },
});

async function getEngagementTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty engagements
    SELECT
      "bountyId" as id
    FROM "BountyEngagement"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bounty engagement metrics
      INSERT INTO "BountyMetric" ("bountyId", timeframe, "favoriteCount", "trackCount")
      SELECT
        "bountyId",
        tf.timeframe,
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Favorite'`)} "favoriteCount",
        ${snippets.timeframeSum('e."createdAt"', '1', `e.type = 'Track'`)} "trackCount"
      FROM "BountyEngagement" e
      JOIN "Bounty" b ON b.id = e."bountyId" -- ensure the bounty exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "bountyId" IN (${ids})
      GROUP BY "bountyId", tf.timeframe
      ON CONFLICT ("bountyId", timeframe) DO UPDATE
        SET "favoriteCount" = EXCLUDED."favoriteCount", "trackCount" = EXCLUDED."trackCount", "updatedAt" = NOW()
    `;
    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getCommentTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty comments
    SELECT t."bountyId" as id
    FROM "Thread" t
    JOIN "CommentV2" c ON c."threadId" = t.id
    WHERE t."bountyId" IS NOT NULL AND c."createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getCommentTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bounty comment metrics
      INSERT INTO "BountyMetric" ("bountyId", timeframe, "commentCount")
      SELECT
        t."bountyId",
        tf.timeframe,
        ${snippets.timeframeSum('c."createdAt"')}
      FROM "Thread" t
      JOIN "Bounty" b ON b.id = t."bountyId" -- ensure the bounty exists
      JOIN "CommentV2" c ON c."threadId" = t.id
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE t."bountyId" IN (${ids})
      GROUP BY t."bountyId", tf.timeframe
      ON CONFLICT ("bountyId", timeframe) DO UPDATE
        SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = NOW()
    `;
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBenefactorTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty benefactors
    SELECT "bountyId" as id
    FROM "BountyBenefactor"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBenefactorTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bounty benefactor metrics
      INSERT INTO "BountyMetric" ("bountyId", timeframe, "benefactorCount", "unitAmountCount")
      SELECT
        "bountyId",
        tf.timeframe,
        ${snippets.timeframeSum('"createdAt"')} as "benefactorCount",
        ${snippets.timeframeSum('"createdAt"', '"unitAmount"')} as "unitAmountCount"
      FROM "BountyBenefactor"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "bountyId" IN (${ids})
      GROUP BY "bountyId", tf.timeframe
      ON CONFLICT ("bountyId", timeframe) DO UPDATE
        SET "benefactorCount" = EXCLUDED."benefactorCount", "unitAmountCount" = EXCLUDED."unitAmountCount", "updatedAt" = NOW()
    `;
    log('getBenefactorTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getEntryTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty entries
    SELECT "bountyId" as id
    FROM "BountyEntry"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEntryTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bounty entry metrics
      INSERT INTO "BountyMetric" ("bountyId", timeframe, "entryCount")
      SELECT
        "bountyId",
        tf.timeframe,
        ${snippets.timeframeSum('"createdAt"')} as "entryCount"
      FROM "BountyEntry"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "bountyId" IN (${ids})
      GROUP BY "bountyId", tf.timeframe
      ON CONFLICT ("bountyId", timeframe) DO UPDATE
        SET "entryCount" = EXCLUDED."entryCount", "updatedAt" = NOW()
    `;
    log('getEntryTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
