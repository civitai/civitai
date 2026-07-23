import type { PageServerLoad } from './$types';
import { getModelPerformance } from '$lib/server/models-earnings';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;
  const modelPerformance = await getModelPerformance({
    userId: locals.user.id,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  }).catch(() => null);
  return { modelPerformance };
};
