import type { PageServerLoad } from './$types';
import { readTableSort } from '$lib/server/table-sort';
import { readModelGrouping } from '$lib/server/model-grouping';
import { getFirstVersionDate, getModelPerformance } from '$lib/server/models-earnings';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import { readBuzzCurrencyFilter } from '$lib/server/buzz-currency-filter';
import { allTimeWindow } from '$lib/date-range';
import { MODEL_PERIOD_COOKIE, parseModelPeriod } from '$lib/model-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const userId = locals.user.id;
  const period = parseModelPeriod(cookies.get(MODEL_PERIOD_COOKIE));
  const modelPerformance = await (async () => {
    if (period === 'all') {
      const floor = await getFirstVersionDate({ userId });
      // A lifetime read on a big creator can be slow: fail fast and show "unavailable". Failures are
      // not cached, so each reload retries, but every attempt is bounded.
      return floor
        ? getModelPerformance({ userId, ...allTimeWindow(floor), maxExecutionSeconds: 10 })
        : [];
    }
    const { range, compare: baseline } = readAnalyticsPeriod(cookies);
    return getModelPerformance({
      userId,
      ...range,
      compareFrom: baseline.range.from,
      compareTo: baseline.range.to,
    });
  })().catch(() => null);
  // Kept out of the cache key on purpose: the payload carries every currency and the filter is applied at
  // render, so a toggle re-runs this load but hits the same cached ClickHouse result.
  return {
    modelPerformance,
    period,
    buzzCurrencies: readBuzzCurrencyFilter(cookies),
    tableSort: readTableSort(cookies, 'models'),
    grouping: readModelGrouping(cookies),
  };
};
