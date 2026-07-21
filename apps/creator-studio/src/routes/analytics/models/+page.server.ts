import type { PageServerLoad } from './$types';
import { getModelPerformance } from '$lib/server/models-earnings';
import { parseMonthRange, resolveCompareMonth } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const compare = resolveCompareMonth(url.searchParams.get('cmp'), range).range;
  const modelPerformance = await getModelPerformance({
    userId: locals.user.id,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  }).catch(() => null);
  return { modelPerformance };
};
