import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals } from '$lib/server/analytics';
import { parseMonthRange, resolveCompareMonth } from '$lib/date-range';

// Overview tab — content activity (userId-keyed ClickHouse) + the comparison-month overlay + all-time totals.
// Month + comparison come from the shared layout; images/models/base-models live on their own tabs.
export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const prev = resolveCompareMonth(url.searchParams.get('cmp'), range).range;
  const userId = locals.user.id;
  const [analytics, analyticsPrev, allTime] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getContentAnalytics({ userId, ...prev }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
  ]);
  return { analytics, analyticsPrev, allTime };
};
