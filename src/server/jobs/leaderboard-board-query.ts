/** Board SQL placeholder for the metric-excluded user ids, which live in ClickHouse and so cannot be joined in Postgres. */
export const METRIC_EXCLUDED_USERS_TOKEN = '{{metricExcludedUserIds}}';

export function intArrayLiteral(ids: number[]) {
  if (!ids.every(Number.isSafeInteger)) throw new Error('excluded user ids must be integers');
  return `'{${ids.join(',')}}'::int[]`;
}

/** A board's stored query with its {{metricExcludedUserIds}} token filled in. */
export function withMetricExcludedUsers(query: string, excludedUserIds: number[]) {
  return query.replaceAll(METRIC_EXCLUDED_USERS_TOKEN, intArrayLiteral(excludedUserIds));
}
