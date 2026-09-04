import type { PageServerLoad } from './$types';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import {
  getMonetizationAdoption,
  getMonetizationDaily,
  getMonetizationMoney,
} from '$lib/server/admin/monetization-overview';

// Platform-wide monetization overview. The access check is the /admin layout's, so this load only reads.
// One period drives the whole page: the chart, the money table and the comparison overlay all follow the
// selected month. Adoption is current state and ignores it.
export const load: PageServerLoad = async ({ cookies }) => {
  const { range, compare } = readAnalyticsPeriod(cookies);
  // Each panel renders its own unavailable state, so one read failing must not take the page with it.
  const [adoption, money, daily, comparison] = await Promise.all([
    getMonetizationAdoption({}).catch(() => null),
    getMonetizationMoney(range).catch(() => null),
    getMonetizationDaily(range).catch(() => null),
    getMonetizationDaily(compare.range).catch(() => null),
  ]);
  return {
    adoption,
    money,
    daily,
    comparison,
    range,
    compare: {
      key: compare.key,
      label: compare.label,
      from: compare.range.from,
      to: compare.range.to,
    },
  };
};
