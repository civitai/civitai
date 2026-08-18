import type { PageServerLoad } from './$types';
import {
  getContentAnalytics,
  getAllTimeTotals,
  impressionTrackingLive,
} from '$lib/server/analytics';
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
  // Deliberately outside the cached analytics payload. This flag starts false and flips true exactly once,
  // so caching it can only ever store a stale `false` — which outlives the event it is wrong about and hides a
  // working feature for the whole TTL. It cost us exactly that: impressions were live and attributed while the
  // tile stayed hidden. The probe is a primary-key seek with LIMIT 1.
  const impressionsTracking = await impressionTrackingLive().catch(() => false);
  return { analytics, analyticsPrev, allTime, impressionsTracking };
};
