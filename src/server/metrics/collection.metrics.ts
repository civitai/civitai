import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefresh, getAffected, getMetricJson, snippets } from '~/server/metrics/metric-helpers';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { collectionsSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';
import { jsonbArrayFrom } from '~/server/db/db-helpers';

const log = createLogger('metrics:collection');

export const collectionMetrics = createMetricProcessor({
  name: 'Collection',
  async update(ctx) {
    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([getItemTasks(ctx), getContributorTasks(ctx)]);
    log('CollectionMetric update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the search index
    //---------------------------------------
    log('update search index');
    await collectionsSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  },
  async clearDay(ctx) {
    await executeRefresh(ctx)`
      UPDATE "CollectionMetric"
        SET "followerCount" = 0, "itemCount" = 0, "contributorCount" = 0
      WHERE timeframe = 'Day'
        AND "updatedAt" > date_trunc('day', now() - interval '1 day');
    `;
  },
  rank: {
    table: 'CollectionRank',
    primaryKey: 'collectionId',
    refreshInterval: 5 * 60 * 1000,
  },
});

async function getContributorTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent collection contributors
    SELECT "collectionId" as id
    FROM "CollectionContributor"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getContributorTasks', i + 1, 'of', tasks.length);
    await executeRefresh(ctx)`
      -- update collection contributor metrics
      INSERT INTO "CollectionMetric" ("collectionId", timeframe, "followerCount", "contributorCount")
      SELECT
        "collectionId",
        tf.timeframe,
        ${snippets.timeframeSum(
          '"createdAt"',
          '1',
          `'VIEW' = ANY(permissions)`
        )} as "followerCount",
        ${snippets.timeframeSum(
          '"createdAt"',
          '1',
          `'ADD' = ANY(permissions)`
        )} as "contributorCount"
      FROM "CollectionContributor"
      CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
      WHERE "collectionId" IN (${ids})
      GROUP BY "collectionId", tf.timeframe
      ON CONFLICT ("collectionId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "contributorCount" = EXCLUDED."contributorCount", "updatedAt" = NOW()
    `;
    log('getContributorTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getItemTasks(ctx: MetricProcessorRunContext) {
  const affected = await getAffected(ctx)`
    -- get recent collection items
    SELECT "collectionId" as id
    FROM "CollectionItem"
    WHERE "createdAt" > '${ctx.lastUpdate}'
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getItemTasks', i + 1, 'of', tasks.length);

    // First, aggregate data into JSON to avoid blocking - only get total count
    const metrics = await getMetricJson(ctx)`
      -- Aggregate collection item metrics into JSON (AllTime count only)
      SELECT jsonb_agg(
        jsonb_build_object(
          'collectionId', "collectionId",
          'itemCount', COUNT(*)
        )
      ) as data
      FROM "CollectionItem"
      WHERE "collectionId" IN (${ids})
      GROUP BY "collectionId"
    `;

    // Then perform the insert from the aggregated data with CROSS JOIN for all timeframes
    if (metrics) {
      await executeRefresh(ctx)`
        -- Insert collection metrics for all timeframes using the AllTime count
        INSERT INTO "CollectionMetric" ("collectionId", timeframe, "itemCount")
        SELECT 
          (value->>'collectionId')::int,
          tf.timeframe,
          (value->>'itemCount')::int
        FROM jsonb_array_elements(${jsonbArrayFrom(metrics)}) AS value
        CROSS JOIN (SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe) tf
        ON CONFLICT ("collectionId", timeframe) DO UPDATE
          SET "itemCount" = EXCLUDED."itemCount", "updatedAt" = NOW()
      `;
    }

    log('getItemTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}
