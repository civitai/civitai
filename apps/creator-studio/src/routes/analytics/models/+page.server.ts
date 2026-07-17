import type { PageServerLoad } from './$types';
import { getModelPerformance } from '$lib/server/models-earnings';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const modelPerformance = await getModelPerformance({ userId: locals.user.id, ...range }).catch(
    () => null
  );
  return { modelPerformance };
};
