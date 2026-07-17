import type { PageServerLoad } from './$types';
import { getEarningsSummary, getEarningsSeries } from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';
import { parseRange, previousRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const prev = previousRange(range);
  // Earnings (ClickHouse) and cash balances (buzz service) come from different sources and degrade independently.
  // `prevSeries` = the previous period's buzz series, for the trend's prior-period overlay.
  const userId = locals.user.id;
  const [earnings, prevSeries, cash] = await Promise.all([
    Promise.all([
      getEarningsSummary({ userId, ...range }),
      getEarningsSeries({ userId, ...range }),
    ]).catch(() => [null, null] as const),
    getEarningsSeries({ userId, ...prev }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
  ]);
  const [summary, series] = earnings;
  return { summary, series, prevSeries, cash, range };
};
