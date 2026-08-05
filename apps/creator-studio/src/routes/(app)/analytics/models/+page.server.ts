import type { PageServerLoad } from './$types';
import { readTableSort } from '$lib/server/table-sort';
import { getModelPerformance } from '$lib/server/models-earnings';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import { readBuzzCurrencyFilter } from '$lib/server/buzz-currency-filter';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;
  const modelPerformance = await getModelPerformance({
    userId: locals.user.id,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  }).catch(() => null);
  // Kept out of the cache key on purpose: the payload carries every currency and the filter is applied at
  // render, so a toggle re-runs this load but hits the same cached ClickHouse result.
  return { modelPerformance, buzzCurrencies: readBuzzCurrencyFilter(cookies) , tableSort: readTableSort(cookies, 'models') };
};
