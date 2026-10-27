import type { Cookies } from '@sveltejs/kit';
import {
  parseMonthParam,
  parseMonthRange,
  resolveCompareMonth,
  type DateRange,
  type CompareBaseline,
} from '$lib/date-range';
import { ANALYTICS_PERIOD_COOKIE } from '$lib/analytics-period';

// Content detail pages (image/article/comic/3D) accept a `?month=YYYY-MM` deep link, so a link from the main site
// can open the current month. Only these routes honor it; every other analytics/earnings page ignores the param.
export function honorsMonthParam(routeId: string | null): boolean {
  return !!routeId && /^\/\(app\)\/analytics\/content\/[^/]+\/\[[^/]+\]$/.test(routeId);
}

// Read the selected analytics period from the host-only cookie (`from|cmp`). Server-readable so SSR loads fetch
// the right month, persistent across tabs/sessions, and it keeps the URL clean. Absent → the last COMPLETED month
// vs the one before it (parseMonthRange; the current month would put a part-month against a whole one).
// `monthParam` (a valid `?month=`) overrides the cookie for that load only: compare is the month before it, and the
// cookie is not written — a deep link must not change the saved choice. The month picker writes the cookie and drops
// the param (see RangeSelector), so the page never sticks to the URL month.
export function readAnalyticsPeriod(
  cookies: Cookies,
  monthParam?: string | null
): {
  range: DateRange;
  compare: CompareBaseline;
} {
  const override = parseMonthParam(monthParam ?? null);
  if (override) return { range: override, compare: resolveCompareMonth(null, override) };
  const [from = '', cmp = ''] = (cookies.get(ANALYTICS_PERIOD_COOKIE) ?? '').split('|');
  const range = parseMonthRange(from || null, null);
  const compare = resolveCompareMonth(cmp || null, range);
  return { range, compare };
}
