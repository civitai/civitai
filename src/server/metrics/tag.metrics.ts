import { chunk } from 'lodash-es';
import type { MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { executeRefreshWithParams, getAffected } from '~/server/metrics/metric-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('metrics:tag');

const metrics = [
  'followerCount',
  'hiddenCount',
  'modelCount',
  'imageCount',
  'postCount',
  'articleCount',
] as const;

type MetricKey = (typeof metrics)[number];
type TagMetricContext = MetricProcessorRunContext & {
  updates: Record<number, Partial<Record<MetricKey, number>> & { tagId: number }>;
};

export const tagMetrics = createMetricProcessor({
  name: 'Tag',
  async update(baseCtx) {
    // Update the context to include the update record
    const ctx = baseCtx as TagMetricContext;
    ctx.updates = {};

    // Get the metric tasks
    //---------------------------------------
    const taskBatches = await Promise.all([
      getEngagementTasks(ctx),
      getModelTasks(ctx),
      // getImageTasks(ctx), // This is too heavy
      getPostTasks(ctx),
      getArticleTasks(ctx),
    ]);
    log('tagMetrics update', taskBatches.flat().length, 'tasks');
    for (const tasks of taskBatches) await limitConcurrency(tasks, 5);

    // Update the tag metrics
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
        `-- update tag metrics
        WITH data AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("tagId" INT, ${metricInsertColumns}))
        INSERT INTO "TagMetric" ("tagId", "timeframe", "updatedAt", ${metricInsertKeys})
        SELECT
          d."tagId",
          'AllTime'::"MetricTimeframe" AS timeframe,
          NOW() as "updatedAt",
          ${metricValues}
        FROM data d
        LEFT JOIN "TagMetric" im ON im."tagId" = d."tagId" AND im."timeframe" = 'AllTime'
        WHERE EXISTS (SELECT 1 FROM "Tag" WHERE id = d."tagId")
        ON CONFLICT ("tagId", "timeframe") DO UPDATE
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
  },
  // Replaced TagRank references with direct metric queries
  // rank: {
  //   table: 'TagRank',
  //   primaryKey: 'tagId',
  //   refreshInterval: 5 * 60 * 1000,
  // },
});

async function getMetrics(ctx: TagMetricContext, sql: string, params: any[] = []) {
  const query = await ctx.pg.cancellableQuery<{ tagId: number } & Record<string, string | number>>(
    sql,
    params
  );
  ctx.jobContext.on('cancel', query.cancel);
  const data = await query.result();
  if (!data.length) return;

  for (const row of data) {
    const tagId = row.tagId;
    ctx.updates[tagId] ??= { tagId };
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (key === 'tagId' || key === 'timeframe') continue;
      const value = row[key];
      if (value == null) continue;
      (ctx.updates[tagId] as any)[key] = typeof value === 'string' ? parseInt(value) : value;
    }
  }
}

async function getEngagementTasks(ctx: TagMetricContext) {
  const affected = await getAffected(ctx)`
    -- get recent tag engagements
    SELECT
      "tagId" as id
    FROM "TagEngagement"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 1000).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log('getEngagementTasks', i + 1, 'of', tasks.length);

    await getMetrics(
      ctx,
      `-- get tag engagement metrics
      SELECT
        "tagId",
        SUM(CASE WHEN type = 'Follow' THEN 1 ELSE 0 END)::int as "followerCount",
        SUM(CASE WHEN type = 'Hide' THEN 1 ELSE 0 END)::int as "hiddenCount"
      FROM "TagEngagement"
      WHERE "tagId" = ANY($1::int[])
      GROUP BY "tagId"`,
      [ids]
    );

    log('getEngagementTasks', i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

const tagCountMap = {
  Models: { table: 'TagsOnModels', column: 'modelCount' },
  Images: { table: 'TagsOnImageDetails', column: 'imageCount' },
  Posts: { table: 'TagsOnPost', column: 'postCount' },
  Articles: { table: 'TagsOnArticle', column: 'articleCount' },
} as const;
async function getTagCountTasks(ctx: TagMetricContext, entity: keyof typeof tagCountMap) {
  const { table, column } = tagCountMap[entity];
  const affected = await getAffected(ctx)`
    -- get recent tag counts
    SELECT
      "tagId" AS id
    FROM "${table}"
    WHERE "createdAt" > ${ctx.lastUpdate}
  `;

  const tasks = chunk(affected, 500).map((ids, i) => async () => {
    ctx.jobContext.checkIfCanceled();
    log(`get ${table} counts`, i + 1, 'of', tasks.length);

    // Removed JOIN to source table for performance (~3.5x faster)
    // Referential integrity ensures only valid entities are counted
    await getMetrics(
      ctx,
      `-- get tag count metrics
      SELECT
        "tagId",
        COUNT(1)::int as "${column}"
      FROM "${table}"
      WHERE "tagId" = ANY($1::int[])
      GROUP BY "tagId"`,
      [ids]
    );

    log(`get ${table} counts`, i + 1, 'of', tasks.length, 'done');
  });

  return tasks;
}

async function getModelTasks(ctx: TagMetricContext) {
  return getTagCountTasks(ctx, 'Models');
}

async function getImageTasks(ctx: TagMetricContext) {
  return getTagCountTasks(ctx, 'Images');
}

async function getPostTasks(ctx: TagMetricContext) {
  return getTagCountTasks(ctx, 'Posts');
}

async function getArticleTasks(ctx: TagMetricContext) {
  return getTagCountTasks(ctx, 'Articles');
}
