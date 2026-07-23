import type { PageServerLoad } from './$types';
import { getContentAnalytics, getAllTimeTotals } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

// Overview tab — content activity (userId-keyed ClickHouse) + the comparison-month overlay + all-time totals.
// Month + comparison come from the shared cookie-backed period; images/models/base-models live on their own tabs.
export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range, compare } = readAnalyticsPeriod(cookies);
  const prev = compare.range;
  const userId = locals.user.id;
  const [analytics, analyticsPrev, allTime] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getContentAnalytics({ userId, ...prev }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
  ]);
  return { analytics, analyticsPrev, allTime };
};
