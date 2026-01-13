import { chunk } from 'lodash-es';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { parameterizedTemplateHandler, templateHandler } from '~/server/db/db-helpers';
import type { JobContext } from '~/server/jobs/job';
import { createLogger } from '~/utils/logging';

const log = createLogger('metric-helpers');

export function getAffected(ctx: {
  pg: AugmentedPool;
  jobContext: JobContext;
  queue: number[];
  addAffected: (id: number | number[]) => void;
}) {
  return parameterizedTemplateHandler(async (sql, params) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql, params);
    ctx.jobContext.on('cancel', affectedQuery.cancel);
    const affected = await affectedQuery.result();
    const idsSet = new Set(ctx.queue);
    affected.forEach((x) => idsSet.add(x.id));
    const ids = [...idsSet].sort((a, b) => a - b);
    ctx.addAffected(ids);

    return ids;
  });
}

export function executeRefresh(ctx: { pg: AugmentedPool; jobContext: JobContext }) {
  return parameterizedTemplateHandler(async (sql, params) => {
    const query = await ctx.pg.cancellableQuery(sql, params);
    ctx.jobContext.on('cancel', query.cancel);
    await query.result();
  });
}

export async function executeRefreshWithParams(
  ctx: { pg: AugmentedPool; jobContext: JobContext },
  sql: string,
  params: any[]
) {
  const query = await ctx.pg.cancellableQuery(sql, params);
  ctx.jobContext.on('cancel', query.cancel);
  await query.result();
}

export function getMetricJson(ctx: { pg: AugmentedPool; jobContext: JobContext }) {
  return parameterizedTemplateHandler(async (sql, params) => {
    const query = await ctx.pg.cancellableQuery<{ data: any }>(sql, params);
    ctx.jobContext.on('cancel', query.cancel);
    const [results] = await query.result();
    return results?.data;
  });
}

function timeframeSum(
  dateField: string,
  value = '1',
  additionalConditions = '',
  timeframeAlias = 'tf'
) {
  const conditionCheck = additionalConditions ? `WHEN NOT (${additionalConditions}) THEN 0` : '';
  additionalConditions =
    additionalConditions && !additionalConditions.startsWith('AND')
      ? `AND ${additionalConditions}`
      : '';
  return `
    SUM(CASE
      ${conditionCheck}
      WHEN ${timeframeAlias}.timeframe = 'AllTime' THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Year' AND ${dateField} > (NOW() - interval '365 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Month' AND ${dateField} > (NOW() - interval '30 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Week' AND ${dateField} > (NOW() - interval '7 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Day' AND ${dateField} > (NOW() - interval '1 days') THEN ${value}
      ELSE 0
    END)
  `;
}

function timeframeCount(
  dateField: string,
  value: string,
  additionalConditions = '',
  timeframeAlias = 'tf'
) {
  const conditionCheck = additionalConditions ? `WHEN NOT (${additionalConditions}) THEN NULL` : '';
  return `
    COUNT(DISTINCT CASE
      ${conditionCheck}
      WHEN ${timeframeAlias}.timeframe = 'AllTime' THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Year' AND ${dateField} > (NOW() - interval '365 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Month' AND ${dateField} > (NOW() - interval '30 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Week' AND ${dateField} > (NOW() - interval '7 days') THEN ${value}
      WHEN ${timeframeAlias}.timeframe = 'Day' AND ${dateField} > (NOW() - interval '1 days') THEN ${value}
      ELSE NULL
    END)
  `;
}

function reactionTimeframe(
  reaction: ReviewReactions,
  reactionElementAlias = 'r',
  timeframeAlias = 'tf'
) {
  return `
    ${timeframeSum(
      `${reactionElementAlias}."createdAt"`,
      '1',
      `${reactionElementAlias}.reaction = '${reaction}'`,
      timeframeAlias
    )} "${reaction.toLowerCase()}Count"
  `;
}

function reactionTimeframes(reactionElementAlias = 'r', timeframeAlias = 'tf') {
  return Object.keys(ReviewReactions)
    .map((reaction) =>
      reactionTimeframe(reaction as ReviewReactions, reactionElementAlias, timeframeAlias)
    )
    .join(',\n');
}

const reactionMetricNames = Object.keys(ReviewReactions)
  .map((reaction) => `"${reaction.toLowerCase()}Count"`)
  .join(', ');

const reactionMetricUpserts = Object.keys(ReviewReactions)
  .map((reaction) => `"${reaction.toLowerCase()}Count" = EXCLUDED."${reaction.toLowerCase()}Count"`)
  .join(', ');

export const snippets = {
  reactionTimeframes,
  timeframeSum,
  timeframeCount,
  reactionMetricNames,
  reactionMetricUpserts,
};

const METRIC_BATCH_SIZE = 200;

type EntityMetricContext = {
  ch: CustomClickHouseClient;
  jobContext: JobContext;
  lastUpdate: Date;
  queue: number[];
  queuedModelVersions: number[];
  addAffected: (ids: number[]) => void;
  modelUpdates: Record<number, { modelId: number } & Record<string, number>>;
  versionUpdates: Record<number, { modelVersionId: number } & Record<string, number>>;
};

export function getEntityMetricTasks(ctx: EntityMetricContext) {
  return async function (
    entityType: 'Model' | 'ModelVersion',
    metricType: string,
    onMetric?: (entityId: number, value: number) => void
  ): Promise<Array<() => Promise<void>>> {
    // Get affected entities from ClickHouse
    const events = await ctx.ch.$query<{ entityId: number }>`
      SELECT DISTINCT entityId
      FROM entityMetricEvents_month
      WHERE entityType = '${entityType}'
        AND metricType = '${metricType}'
        AND createdAt >= ${ctx.lastUpdate}
    `;

    // Merge with appropriate queue
    const queue = entityType === 'Model' ? ctx.queue : ctx.queuedModelVersions;
    const affected = [...new Set([...events.map((x) => x.entityId), ...queue])];

    // Track affected models
    if (entityType === 'Model') {
      ctx.addAffected(affected);
    }

    // Create batched tasks
    const tasks = chunk(affected, METRIC_BATCH_SIZE).map((ids, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log(`getEntityMetricTasks(${entityType}, ${metricType})`, i + 1, 'of', tasks.length);

      const metrics = await ctx.ch.$query<{ entityId: number; value: number }>`
        SELECT
          entityId,
          sum(total) AS value
        FROM (
          SELECT
            entityId,
            day,
            argMax(total, refreshedAt) AS total
          FROM entityMetricDailyAgg_new
          WHERE entityType = '${entityType}'
            AND metricType = '${metricType}'
            AND entityId IN (${ids})
          GROUP BY entityId, day
        )
        GROUP BY entityId
      `;

      ctx.jobContext.checkIfCanceled();

      for (const row of metrics) {
        if (onMetric) {
          onMetric(row.entityId, row.value);
        } else if (entityType === 'Model') {
          const modelId = row.entityId;
          ctx.modelUpdates[modelId] ??= { modelId };
          (ctx.modelUpdates[modelId] as Record<string, number>)[metricType] = row.value;
        } else {
          const modelVersionId = row.entityId;
          ctx.versionUpdates[modelVersionId] ??= { modelVersionId };
          (ctx.versionUpdates[modelVersionId] as Record<string, number>)[metricType] = row.value;
        }
      }

      log(`getEntityMetricTasks(${entityType}, ${metricType})`, i + 1, 'of', tasks.length, 'done');
    });

    return tasks;
  };
}
