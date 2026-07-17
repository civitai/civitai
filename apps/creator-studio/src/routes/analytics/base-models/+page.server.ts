import type { PageServerLoad } from './$types';
import { getBaseModelPerformance } from '$lib/server/models-earnings';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const baseModels = await getBaseModelPerformance({ userId: locals.user.id, ...range }).catch(
    () => null
  );
  return { baseModels };
};
