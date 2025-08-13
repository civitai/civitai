import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, snippets } from '~/server/metrics/metric-helpers';
import { bountiesSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { jsonbArrayFrom } from '~/server/db/db-helpers';

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
    
    // First, aggregate data into JSON to avoid blocking
    const metrics = await ctx.db.$queryRaw<{ data: any }[]>`
      -- Aggregate bounty engagement metrics into JSON
      WITH metric_data AS (
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
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'bountyId', "bountyId",
          'timeframe', timeframe,
          'favoriteCount', "favoriteCount",
          'trackCount', "trackCount"
        )
      ) as data
      FROM metric_data
    `;
    
    // Then perform the insert from the aggregated data
    if (metrics?.[0]?.data) {
      await executeRefresh(ctx)`
        -- Insert pre-aggregated bounty engagement metrics
        INSERT INTO "BountyMetric" ("bountyId", timeframe, "favoriteCount", "trackCount")
        SELECT 
          (value->>'bountyId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'favoriteCount')::int,
          (value->>'trackCount')::int
        FROM jsonb_array_elements(${jsonbArrayFrom(metrics[0].data)}) AS value
        ON CONFLICT ("bountyId", timeframe) DO UPDATE
          SET "favoriteCount" = EXCLUDED."favoriteCount", "trackCount" = EXCLUDED."trackCount", "updatedAt" = NOW()
      `;
    }
    
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
    
    // First, aggregate data into JSON to avoid blocking
    const metrics = await ctx.db.$queryRaw<{ data: any }[]>`
      -- Aggregate bounty comment metrics into JSON
      WITH metric_data AS (
        SELECT
          t."bountyId",
          tf.timeframe,
          ${snippets.timeframeSum('c."createdAt"')} as "commentCount"
        FROM "Thread" t
        JOIN "Bounty" b ON b.id = t."bountyId" -- ensure the bounty exists
        JOIN "CommentV2" c ON c."threadId" = t.id
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE t."bountyId" IN (${ids})
        GROUP BY t."bountyId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'bountyId', "bountyId",
          'timeframe', timeframe,
          'commentCount', "commentCount"
        )
      ) as data
      FROM metric_data
    `;
    
    // Then perform the insert from the aggregated data
    if (metrics?.[0]?.data) {
      await executeRefresh(ctx)`
        -- Insert pre-aggregated bounty comment metrics
        INSERT INTO "BountyMetric" ("bountyId", timeframe, "commentCount")
        SELECT 
          (value->>'bountyId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'commentCount')::int
        FROM jsonb_array_elements(${jsonbArrayFrom(metrics[0].data)}) AS value
        ON CONFLICT ("bountyId", timeframe) DO UPDATE
          SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = NOW()
      `;
    }
    
    log('getCommentTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getBenefactorTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent bounty benefactors
    SELECT "bountyId" as id
    FROM "BountyBenefactor"
    WHERE "createdAt" > '${ctx.lastUpdate}' OR "updatedAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getBenefactorTasks', i + 1, 'of', tasks.length);
    
    // First, aggregate data into JSON to avoid blocking
    const metrics = await ctx.db.$queryRaw<{ data: any }[]>`
      -- Aggregate bounty benefactor metrics into JSON
      WITH metric_data AS (
        SELECT
          "bountyId",
          tf.timeframe,
          ${snippets.timeframeSum('"createdAt"')} as "benefactorCount",
          ${snippets.timeframeSum('"createdAt"', '"unitAmount"')} as "unitAmountCount"
        FROM "BountyBenefactor"
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE "bountyId" IN (${ids})
        GROUP BY "bountyId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'bountyId', "bountyId",
          'timeframe', timeframe,
          'benefactorCount', "benefactorCount",
          'unitAmountCount', "unitAmountCount"
        )
      ) as data
      FROM metric_data
    `;
    
    // Then perform the insert from the aggregated data
    if (metrics?.[0]?.data) {
      await executeRefresh(ctx)`
        -- Insert pre-aggregated bounty benefactor metrics
        INSERT INTO "BountyMetric" ("bountyId", timeframe, "benefactorCount", "unitAmountCount")
        SELECT 
          (value->>'bountyId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'benefactorCount')::int,
          (value->>'unitAmountCount')::int
        FROM jsonb_array_elements(${jsonbArrayFrom(metrics[0].data)}) AS value
        ON CONFLICT ("bountyId", timeframe) DO UPDATE
          SET "benefactorCount" = EXCLUDED."benefactorCount", "unitAmountCount" = EXCLUDED."unitAmountCount", "updatedAt" = NOW()
      `;
    }
    
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
    
    // First, aggregate data into JSON to avoid blocking
    const metrics = await ctx.db.$queryRaw<{ data: any }[]>`
      -- Aggregate bounty entry metrics into JSON
      WITH metric_data AS (
        SELECT
          "bountyId",
          tf.timeframe,
          ${snippets.timeframeSum('"createdAt"')} as "entryCount"
        FROM "BountyEntry"
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        WHERE "bountyId" IN (${ids})
        GROUP BY "bountyId", tf.timeframe
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'bountyId', "bountyId",
          'timeframe', timeframe,
          'entryCount', "entryCount"
        )
      ) as data
      FROM metric_data
    `;
    
    // Then perform the insert from the aggregated data
    if (metrics?.[0]?.data) {
      await executeRefresh(ctx)`
        -- Insert pre-aggregated bounty entry metrics
        INSERT INTO "BountyMetric" ("bountyId", timeframe, "entryCount")
        SELECT 
          (value->>'bountyId')::int,
          (value->>'timeframe')::"MetricTimeframe",
          (value->>'entryCount')::int
        FROM jsonb_array_elements(${jsonbArrayFrom(metrics[0].data)}) AS value
        ON CONFLICT ("bountyId", timeframe) DO UPDATE
          SET "entryCount" = EXCLUDED."entryCount", "updatedAt" = NOW()
      `;
    }
    
    log('getEntryTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
