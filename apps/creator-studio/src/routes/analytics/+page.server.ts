import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals } from '$lib/server/analytics';
import { getModelPerformance } from '$lib/server/models-earnings';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const userId = locals.user.id;
  // Period analytics + all-time totals + per-model performance degrade independently (a ClickHouse hiccup on one
  // shouldn't blank the others).
  const [analytics, allTime, modelPerformance] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
    getModelPerformance({ userId, ...range }).catch(() => null),
  ]);
  return { analytics, allTime, modelPerformance, range };
};
