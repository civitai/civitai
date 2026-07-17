import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals } from '$lib/server/analytics';
import { parseRange, previousRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const prev = previousRange(range);
  const userId = locals.user.id;
  const [analytics, analyticsPrev, allTime] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getContentAnalytics({ userId, ...prev }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
  ]);
  return { analytics, analyticsPrev, allTime };
};
