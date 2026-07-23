import type { PageServerLoad } from './$types';
import { getTopMedia } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range } = readAnalyticsPeriod(cookies);
  // One query serves both tabs — `getTopMedia` already returns images and videos together (split by `type`).
  const media = await getTopMedia({ userId: locals.user.id, ...range }).catch(() => null);
  return {
    images: media ? media.filter((m) => m.type === 'image') : null,
    videos: media ? media.filter((m) => m.type === 'video') : null,
  };
};
