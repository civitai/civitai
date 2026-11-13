import { ReviewReactions } from '~/shared/utils/prisma/enums';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { parameterizedTemplateHandler, templateHandler } from '~/server/db/db-helpers';
import type { JobContext } from '~/server/jobs/job';
import { excludedReactorFilter } from '~/shared/utils/excluded-reactor-filter';

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

export const snippets = {
  excludedReactorFilter,
  reactionTimeframes,
  timeframeSum,
  timeframeCount,
  reactionMetricNames,
  reactionMetricUpserts,
};
