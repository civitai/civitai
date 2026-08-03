import type { PageServerLoad } from './$types';
import {
  getEarningsSummary,
  getEarningsSeries,
  getMonthlyEarnings,
  getBuzzDollarRatio,
} from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  // The period comes from the shared cookie, NOT the URL: RangeSelector only ever writes that cookie, so reading
  // search params here left every month change resolving back to the current month. Same source as the analytics
  // loads. Comparison month (strictly earlier than the selected one) drives the trend overlay AND the delta chips.
  const { range, compare } = readAnalyticsPeriod(cookies);
  // Last elapsed day of the selected month — the trend draws the full month on the x-axis but the current line stops
  // here (a partial month shouldn't read as a dip to zero for days that haven't happened).
  const todayIso = new Date().toISOString().slice(0, 10);
  const through = range.to < todayIso ? range.to : todayIso;
  // Earnings (ClickHouse) and cash balances (buzz service) come from different sources and degrade independently.
  // `cmpSummary`/`cmpSeries` = the comparison month's by-source totals + daily series; `monthly` = the last-12-months
  // table, which is independent of the selected month.
  const userId = locals.user.id;
  const [earnings, cmpSummary, cmpSeries, cash, monthly, buzzRatio] = await Promise.all([
    Promise.all([
      getEarningsSummary({ userId, ...range }),
      getEarningsSeries({ userId, ...range }),
    ]).catch(() => [null, null] as const),
    getEarningsSummary({ userId, ...compare.range }).catch(() => null),
    getEarningsSeries({ userId, ...compare.range }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
    getMonthlyEarnings({ userId }).catch(() => null),
    getBuzzDollarRatio({ userId }).catch(() => null),
  ]);
  const [summary, series] = earnings;
  return {
    summary,
    series,
    cmpSummary,
    cmpSeries,
    compare: {
      key: compare.key,
      label: compare.label,
      from: compare.range.from,
      to: compare.range.to,
    },
    through,
    cash,
    monthly,
    buzzRatio,
    range,
  };
};
