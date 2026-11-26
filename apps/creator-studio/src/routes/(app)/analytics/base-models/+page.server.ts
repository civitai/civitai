import type { PageServerLoad } from './$types';
import { readTableSort } from '$lib/server/table-sort';
import { getBaseModelPerformance } from '$lib/server/models-earnings';
import { getBaseModelTrends } from '$lib/server/base-model-trends';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import { marketOverviewEnabled } from '$lib/server/market-overview';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;
  const [baseModels, platformTrends, marketEnabled] = await Promise.all([
    getBaseModelPerformance({
      userId: locals.user.id,
      ...range,
      compareFrom: compare.from,
      compareTo: compare.to,
    }).catch(() => null),
    getBaseModelTrends(range).catch(() => null),
    marketOverviewEnabled(locals.user).catch(() => false),
  ]);
  // The comparison month must cover exactly the primary's base models so each line has a matching overlay.
  const names = platformTrends?.map((t) => t.baseModel) ?? [];
  const platformTrendsCompare = names.length
    ? await getBaseModelTrends({
        from: compare.from,
        to: compare.to,
        only: names.join('\n'),
      }).catch(() => null)
    : null;
  const ownBaseModels = baseModels ? [...new Set(baseModels.map((b) => b.baseModel))] : [];
  return {
    baseModels,
    platformTrends,
    platformTrendsCompare,
    ownBaseModels,
    marketEnabled,
    range,
    tableSort: readTableSort(cookies, 'base-models'),
  };
};
