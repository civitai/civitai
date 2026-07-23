import type { PageServerLoad } from './$types';
import { getTopMedia } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range } = readAnalyticsPeriod(cookies);
  const media = await getTopMedia({ userId: locals.user.id, ...range }).catch(() => null);
  const images = media ? media.filter((m) => m.type === 'image') : null;
  return { images };
};
