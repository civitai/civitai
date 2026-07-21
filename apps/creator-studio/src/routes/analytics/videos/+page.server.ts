import type { PageServerLoad } from './$types';
import { getTopMedia } from '$lib/server/analytics';
import { parseMonthRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const media = await getTopMedia({ userId: locals.user.id, ...range }).catch(() => null);
  const videos = media ? media.filter((m) => m.type === 'video') : null;
  return { videos };
};
