import type { PageServerLoad } from './$types';
import { getBaseModelPerformance } from '$lib/server/models-earnings';
import { parseMonthRange, resolveCompareMonth } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const compare = resolveCompareMonth(url.searchParams.get('cmp'), range).range;
  const baseModels = await getBaseModelPerformance({
    userId: locals.user.id,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  }).catch(() => null);
  return { baseModels };
};
