import type { PageServerLoad } from './$types';
import { getEarningsSummary, getEarningsSeries } from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  // Earnings (ClickHouse) and cash balances (buzz service) come from different sources and degrade independently.
  const userId = locals.user.id;
  const [earnings, cash] = await Promise.all([
    Promise.all([
      getEarningsSummary({ userId, ...range }),
      getEarningsSeries({ userId, ...range }),
    ]).catch(() => [null, null] as const),
    getCreatorCash({ userId }).catch(() => null),
  ]);
  const [summary, series] = earnings;
  return { summary, series, cash, range };
};
