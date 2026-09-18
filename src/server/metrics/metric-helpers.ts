import { chunk } from 'lodash-es';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { parameterizedTemplateHandler, templateHandler } from '~/server/db/db-helpers';
import type { JobContext } from '~/server/jobs/job';
import { createLogger } from '~/utils/logging';
import { buildEntityMetricPerDaySource } from '~/server/flipt/client';

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
  // `IS NOT TRUE` rather than `NOT (...)` so an outer-joined row, where the condition is
  // NULL rather than false, scores 0 instead of falling through to the AllTime arm and
  // counting a reaction that is not there. Identical for every inner-joined caller.
  const conditionCheck = additionalConditions
    ? `WHEN (${additionalConditions}) IS NOT TRUE THEN 0`
    : '';
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

/**
 * The metric columns a reaction aggregate writes. Exported because a job has to seed them
 * to zero for the entities the aggregate returns no row for, which the three post/article
 * reaction tasks do inline before issuing their query.
 */
export const reactionCountKeys = Object.keys(ReviewReactions).map(
  (reaction) => `${reaction.toLowerCase()}Count`
);

const reactionMetricNames = Object.keys(ReviewReactions)
  .map((reaction) => `"${reaction.toLowerCase()}Count"`)
  .join(', ');

const reactionMetricUpserts = Object.keys(ReviewReactions)
  .map((reaction) => `"${reaction.toLowerCase()}Count" = EXCLUDED."${reaction.toLowerCase()}Count"`)
  .join(', ');

/**
 * `AND r."userId" NOT IN (...)` for the metric-excluded users, or `''` when the list is
 * empty. Emitted as literal SQL rather than a bound parameter because the reaction
 * queries run through `templateHandler`, which interpolates; a string is the one value
 * both template handlers pass through verbatim, so one snippet serves both.
 *
 * The column is hardcoded rather than a parameter. Every reaction aggregate aliases its
 * reaction table `r`, and a parameter here would be raw SQL text that the integer guard
 * beside it does not cover — while reading as though it did. A caller passing the wrong
 * alias (`i."userId"` in the post job, which joins `Image i`) is valid SQL that filters
 * by the post's OWNER instead of the reactor.
 *
 * Non-integer ids throw. They cannot reach here from `getMetricExcludedUserIdsOrThrow`,
 * which already coerces — but this builds SQL text, and dropping an unexpected id would
 * silently keep counting that user's reactions, which is the bug this exists to fix.
 */
function excludedReactorFilter(excludedUserIds: number[]) {
  if (!excludedUserIds.length) return '';
  for (const id of excludedUserIds) {
    if (!Number.isInteger(id)) throw new Error(`non-integer excluded user id: ${id}`);
  }
  return `AND r."userId" NOT IN (${excludedUserIds.join(',')})`;
}

export const snippets = {
  excludedReactorFilter,
  reactionTimeframes,
  timeframeSum,
  timeframeCount,
  reactionMetricNames,
  reactionMetricUpserts,
};

const METRIC_BATCH_SIZE = 200;

// Add additional entity types here as needed
type EntityType = 'Model' | 'ModelVersion' | 'Post' | 'Article' | 'Image' | 'Collection';

type EntityMetricContext = {
  ch: CustomClickHouseClient;
  jobContext: JobContext;
  lastUpdate: Date;
  queue: number[];
  updates: Record<number, Record<string, number>>;
  idKey: string;
  addAffected?: (ids: number[]) => void;
};

type EntityMetricOptions = {
  updates?: Record<number, Record<string, number>>;
  idKey?: string;
  queue?: number[];
  addAffected?: (ids: number[]) => void;
};

// The agg table refreshes every 5 minutes. We use a 30s buffer to account for refresh duration.
const AGG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AGG_REFRESH_BUFFER_MS = 30 * 1000;

const getAggInterval = (date: Date) => Math.floor(date.getTime() / AGG_REFRESH_INTERVAL_MS);

const floorToAggInterval = (date: Date) =>
  new Date(getAggInterval(date) * AGG_REFRESH_INTERVAL_MS - AGG_REFRESH_BUFFER_MS);

const hasCrossedAggBoundary = (lastUpdate: Date) =>
  getAggInterval(lastUpdate) !== getAggInterval(new Date());

export function getEntityMetricTasks(ctx: EntityMetricContext) {
  return async function (
    entityType: EntityType,
    metricType: string,
    options?: EntityMetricOptions
  ): Promise<Array<() => Promise<void>>> {
    // Use provided options or fall back to context defaults
    const updates = options?.updates ?? ctx.updates;
    const idKey = options?.idKey ?? ctx.idKey;
    const queue = options?.queue ?? ctx.queue;
    const addAffected = options?.addAffected ?? ctx.addAffected;

    // Skip if we haven't crossed an agg refresh boundary (no new data to fetch)
    if (!hasCrossedAggBoundary(ctx.lastUpdate)) {
      log(`getEntityMetricTasks(${entityType}, ${metricType}) skipped - no new agg data`);
      return [];
    }

    // Floor lastUpdate to the agg refresh interval to ensure we don't miss events
    // that were processed in the latest agg table refresh
    const lastUpdateFloored = floorToAggInterval(ctx.lastUpdate);

    // Get affected entities from ClickHouse
    const events = await ctx.ch.$query<{ entityId: number }>`
      SELECT DISTINCT entityId
      FROM entityMetricEvents_month
      WHERE entityType = '${entityType}'
        AND metricType = '${metricType}'
        AND createdAt >= ${lastUpdateFloored}
    `;

    // Merge with queue
    const affected = [...new Set([...events.map((x) => x.entityId), ...queue])];

    // Track affected if callback provided
    if (addAffected) {
      addAffected(affected);
    }

    // Create batched tasks
    const tasks = chunk(affected, METRIC_BATCH_SIZE).map((ids, i) => async () => {
      ctx.jobContext.checkIfCanceled();
      log(`getEntityMetricTasks(${entityType}, ${metricType})`, i + 1, 'of', tasks.length);

      const perDaySource = buildEntityMetricPerDaySource(
        `WHERE entityType = '${entityType}'
            AND metricType = '${metricType}'
            AND entityId IN (${ids.join(',')})`
      );
      const metrics = await ctx.ch.$query<{ entityId: number; value: number }>(`
        SELECT
          entityId,
          sum(total) AS value
        FROM ${perDaySource}
        GROUP BY entityId
      `);

      ctx.jobContext.checkIfCanceled();

      for (const row of metrics) {
        const entityId = row.entityId;
        updates[entityId] ??= { [idKey]: entityId };
        updates[entityId][metricType] = row.value;
      }

      log(`getEntityMetricTasks(${entityType}, ${metricType})`, i + 1, 'of', tasks.length, 'done');
    });

    return tasks;
  };
}
