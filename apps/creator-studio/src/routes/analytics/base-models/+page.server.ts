import type { PageServerLoad } from './$types';
import { getBaseModelPerformance } from '$lib/server/models-earnings';
import { getBaseModelTrends } from '$lib/server/base-model-trends';
import { parseMonthRange, resolveCompareMonth } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const compare = resolveCompareMonth(url.searchParams.get('cmp'), range).range;
  const [baseModels, platformTrends] = await Promise.all([
    getBaseModelPerformance({
      userId: locals.user.id,
      ...range,
      compareFrom: compare.from,
      compareTo: compare.to,
    }).catch(() => null),
    getBaseModelTrends(range).catch(() => null),
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
  return { baseModels, platformTrends, platformTrendsCompare, ownBaseModels, range };
};
