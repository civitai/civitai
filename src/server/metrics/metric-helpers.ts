import { ReviewReactions } from '@prisma/client';
import { AugmentedPool, templateHandler } from '~/server/db/pgDb';
import { JobContext } from '~/server/jobs/job';
import { MetricProcessorRunContext } from '~/server/metrics/base.metrics';

export function getAffected(ctx: MetricProcessorRunContext) {
  return templateHandler(async (sql) => {
    const affectedQuery = await ctx.pg.cancellableQuery<{ id: number }>(sql);
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
  return templateHandler(async (sql) => {
    const query = await ctx.pg.cancellableQuery(sql);
    ctx.jobContext.on('cancel', query.cancel);
    await query.result();
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
