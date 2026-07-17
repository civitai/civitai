import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals } from '$lib/server/analytics';
import { getModelPerformance } from '$lib/server/models-earnings';
import { parseRange, previousRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const prev = previousRange(range);
  const userId = locals.user.id;
  // Period analytics + the previous-period comparison + all-time totals + per-model performance degrade
  // independently (a ClickHouse hiccup on one shouldn't blank the others). `analyticsPrev` feeds the totals delta
  // chips and the prior-period chart overlay.
  const [analytics, analyticsPrev, allTime, modelPerformance] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getContentAnalytics({ userId, ...prev }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
    getModelPerformance({ userId, ...range }).catch(() => null),
  ]);
  return { analytics, analyticsPrev, allTime, modelPerformance, range };
};
