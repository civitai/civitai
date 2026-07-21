import type { PageServerLoad } from './$types';
import {
  getEarningsSummary,
  getEarningsSeries,
  getMonthlyEarnings,
  getBuzzDollarRatio,
} from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';
import { parseRange, previousRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const prev = previousRange(range);
  // Earnings (ClickHouse) and cash balances (buzz service) come from different sources and degrade independently.
  // `prevSeries` = the previous period's buzz series (trend overlay); `monthly` = last-12-months table, which is
  // independent of the selected range.
  const userId = locals.user.id;
  const [earnings, prevSeries, cash, monthly, buzzRatio] = await Promise.all([
    Promise.all([
      getEarningsSummary({ userId, ...range }),
      getEarningsSeries({ userId, ...range }),
    ]).catch(() => [null, null] as const),
    getEarningsSeries({ userId, ...prev }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
    getMonthlyEarnings({ userId }).catch(() => null),
    getBuzzDollarRatio({ userId }).catch(() => null),
  ]);
  const [summary, series] = earnings;
  return { summary, series, prevSeries, cash, monthly, buzzRatio, range };
};
