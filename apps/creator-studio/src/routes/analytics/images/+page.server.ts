import type { PageServerLoad } from './$types';
import { getTopMedia } from '$lib/server/analytics';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  const media = await getTopMedia({ userId: locals.user.id, ...range }).catch(() => null);
  const images = media ? media.filter((m) => m.type === 'image') : null;
  return { images };
};
