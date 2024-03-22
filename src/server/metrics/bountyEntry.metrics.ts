import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { chunk } from 'lodash-es';

const log = createLogger('metrics:bounty');

export const bountyEntryMetrics = createMetricProcessor({
  name: 'BountyEntry',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getReactionTasks(ctx),
      getBenefactorTasks(ctx),
      getBuzzTasks(ctx),
    ]);
    log('BountyEntryMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);
  },
  async clearDay(ctx) {
    await executeRefresh(ctx)`
      UPDATE "BountyEntryMetric"
        SET "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "heartCount" = 0, "unitAmountCount" = 0, "tippedCount" = 0, "tippedAmountCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'BountyEntryRank',
    primaryKey: 'bountyEntryId',
    refreshInterval: 5 * 60 * 1000,
  },
});

async function getReactionTasks(ctx: MetricProcessorRunContext) {
  log('getReactionTasks', ctx.lastUpdate);
  const affected = await getAffected(ctx)`
    -- get recent bounty entry reactions
    SELECT
      "bountyEntryId" AS id
    FROM "BountyEntryReaction"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getReactionTasks', i + 1, 'of', tasks.length);

    await executeRefresh(ctx)`
      -- update bounty entry reaction metrics
      INSERT INTO "BountyEntryMetric" ("bountyEntryId", timeframe, ${snippets.reactionMetricNames})
      SELECT
        r."bountyEntryId",
        tf.timeframe,
        ${snippets.reactionTimeframes()}
      FROM "BountyEntryReaction" r
      JOIN "BountyEntry" be ON be.id = r."bountyEntryId" -- ensure the bountyEntry exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE r."bountyEntryId" IN (${ids.join(',')})
      GROUP BY r."bountyEntryId", tf.timeframe
      ON CONFLICT ("bountyEntryId", timeframe) DO UPDATE
        SET ${snippets.reactionMetricUpserts}, "updatedAt" = NOW()
    `;
    log('getReactionTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBenefactorTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty entry benefactors
    SELECT "awardedToId" as id
    FROM "BountyBenefactor"
    WHERE "createdAt" > '${ctx.lastUpdate}'
      AND "awardedToId" IS NOT NULL
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBenefactorTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bounty entry benefactor metrics
      INSERT INTO "BountyEntryMetric" ("bountyEntryId", timeframe, "unitAmountCount")
      SELECT
        bb."awardedToId",
        tf.timeframe,
        ${snippets.timeframeSum('"createdAt"', '"unitAmount"')} as "unitAmountCount"
      FROM "BountyBenefactor" bb
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE bb."awardedToId" IN (${ids.join(',')})
      GROUP BY bb."bountyId", bb."awardedToId", tf.timeframe
      ON CONFLICT ("bountyEntryId", timeframe) DO UPDATE
        SET "unitAmountCount" = EXCLUDED."unitAmountCount", "updatedAt" = NOW()
    `;
    log('getBenefactorTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBuzzTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bountyEntry tips
    SELECT "entityId" as id
    FROM "BuzzTip"
    WHERE "entityType" = 'bountyEntry' AND "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBuzzTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update bountyEntry tip metrics
      INSERT INTO "BountyEntryMetric" ("bountyEntryId", timeframe, "tippedCount", "tippedAmountCount")
      SELECT
        "entityId",
        tf.timeframe,
        ${snippets.timeframeSum('bt."updatedAt"')} "tippedCount",
        ${snippets.timeframeSum('bt."updatedAt"', 'amount')} "tippedAmountCount"
      FROM "BuzzTip" bt
      JOIN "BountyEntry" be ON be.id = bt."entityId" -- ensure the bountyEntry exists
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "entityId" IN (${ids.join(',')}) AND "entityType" = 'bountyEntry'
      GROUP BY "entityId", tf.timeframe
      ON CONFLICT ("bountyEntryId", timeframe) DO UPDATE
        SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = NOW()
    `;
    log('getBuzzTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
