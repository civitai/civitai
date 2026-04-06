import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import {
  executeRefreshWithParams,
  getAffected,
  getEntityMetricTasks,
} from '~/server/metrics/metric-helpers';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { collectionsSearchIndex } from '~/server/search-index';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:collection');

const metrics = ['followerCount', 'contributorCount', 'itemCount'] as const;

type CollectionMetricContext = MetricProcessorRunContext & {
  updates: Record<number, Record<string, number>>;
  idKey: string;
};

export const collectionMetrics = createMetricProcessor({
  name: 'Collection',
  async update(baseCtx) {
    // Update the context to include the update record
    const ctx = baseCtx as CollectionMetricContext;
    ctx.updates = {};
    ctx.idKey = 'collectionId';

    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([getItemTasks(ctx), getContributorTasks(ctx)]);
    log('CollectionMetric update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the collection metrics
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
        `-- update collection metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("collectionId" INT, ${metricInsertColumns}))
        INSERT INTO "CollectionMetric" ("collectionId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."collectionId",
          'AllTime'::"MetricTimeframe" AS timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "CollectionMetric" im ON im."collectionId" = d."collectionId" AND im."timeframe" = 'AllTime'
        WHERE EXISTS (SELECT 1 FROM "Collection" WHERE id = d."collectionId")
        ON CONFLICT ("collectionId", "timeframe") DO UPDATE
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
    await collectionsSearchIndex.queueUpdate(
      [...ctx.affected].map((id) => ({
        id,
        action: SearchIndexUpdateQueueAction.Update,
      }))
    );
  },
  // Not using day metrics anymore
  // async clearDay(ctx) {
  //   await executeRefresh(ctx)`
  //     UPDATE "CollectionMetric"
  //       SET "followerCount" = 0, "itemCount" = 0, "contributorCount" = 0
  //     WHERE timeframe = 'Day'
  //       AND "updatedAt" > date_trunc('day', now() - interval '1 day');
  //   `;
  // },
  // Doesn't appear to be used anymore
  // rank: {
  //   table: 'CollectionRank',
  //   primaryKey: 'collectionId',
  //   refreshInterval: 5 * 60 * 1000,
  // },
});

async function getMetrics(ctx: CollectionMetricContext, sql: string, params: any[] = []) {
  const query = await ctx.pg.cancellableQuery<
    { collectionId: number } & Record<string, string | number>
  >(sql, params);
  ctx.jobContext.on('cancel', query.cancel);
  const data = await query.result();
  if (!data.length) return;

  for (const row of data) {
    const entityId = row.collectionId;
    ctx.updates[entityId] ??= { [ctx.idKey]: entityId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === ctx.idKey || key === 'timeframe') continue;
      const value = row[key];
      if (value == null) continue;
      ctx.updates[entityId][key] = typeof value === 'string' ? parseInt(value) : value;
    }
  }
}

async function getContributorTasks(ctx: CollectionMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent collection contributors
    SELECT "collectionId" as id
    FROM "CollectionContributor"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 100).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getContributorTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get collection contributor metrics
      SELECT
        "collectionId",
        SUM(CASE WHEN 'VIEW' = ANY(permissions) THEN 1 ELSE 0 END)::int as "followerCount",
        SUM(CASE WHEN 'ADD' = ANY(permissions) THEN 1 ELSE 0 END)::int as "contributorCount"
      FROM "CollectionContributor"
      WHERE "collectionId" = ANY($1::int[])
      GROUP BY "collectionId"`,
      [ids]
    );

    log('getContributorTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getItemTasks(ctx: CollectionMetricContext) {
  return getEntityMetricTasks(ctx)('Collection', 'itemCount');
}
