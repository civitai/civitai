import type { Cookies } from '@sveltejs/kit';
import {
  parseMonthRange,
  resolveCompareMonth,
  type DateRange,
  type CompareBaseline,
} from '$lib/date-range';
import { ANALYTICS_PERIOD_COOKIE } from '$lib/analytics-period';

// Read the selected analytics period from the host-only cookie (`from|cmp`). Server-readable so SSR loads fetch
// the right month, persistent across tabs/sessions, and it keeps the URL clean. Absent → current month vs prior.
export function readAnalyticsPeriod(cookies: Cookies): {
  range: DateRange;
  compare: CompareBaseline;
} {
  const [from = '', cmp = ''] = (cookies.get(ANALYTICS_PERIOD_COOKIE) ?? '').split('|');
  const range = parseMonthRange(from || null, null);
  const compare = resolveCompareMonth(cmp || null, range);
  return { range, compare };
}
