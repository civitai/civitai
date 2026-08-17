import type { PageServerLoad } from './$types';
import { getTopMedia, getTopArticles, getComics } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range } = readAnalyticsPeriod(cookies);
  // One query serves both media tabs — `getTopMedia` already returns images and videos together (split by
  // `type`). Articles and comics are separate sources (different ranking, different stores), so each gets its
  // own fetch and falls back to null independently rather than one failure blanking every tab.
  const [media, articles, comics] = await Promise.all([
    getTopMedia({ userId: locals.user.id, ...range }).catch(() => null),
    getTopArticles({ userId: locals.user.id, ...range }).catch(() => null),
    getComics({ userId: locals.user.id, ...range }).catch(() => null),
  ]);
  return {
    images: media ? media.filter((m) => m.type === 'image') : null,
    videos: media ? media.filter((m) => m.type === 'video') : null,
    articles,
    comics,
  };
};
