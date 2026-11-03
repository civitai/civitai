import type { PageServerLoad } from './$types';
import { getTopMedia, getTopArticles, getComics, getModel3ds } from '$lib/server/analytics';
import { recentInRange } from '$lib/content-sort';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, cookies, url }) => {
  const { range } = readAnalyticsPeriod(cookies);
  // Only Recent reaches the server: the other sorts re-rank the reaction pool in the browser. Recent needs a
  // different pool (the newest items, not the most-reacted), so reading the param here is what reloads it.
  const pool = url.searchParams.get('sort') === 'recent' ? 'recent' : 'top';
  // One query serves both media tabs — `getTopMedia` already returns images and videos together (split by
  // `type`). Articles and comics are separate sources (different ranking, different stores), so each gets its
  // own fetch and falls back to null independently rather than one failure blanking every tab.
  const [media, articles, comics, model3ds] = await Promise.all([
    getTopMedia({ userId: locals.user.id, ...range, pool }).catch(() => null),
    getTopArticles({ userId: locals.user.id, ...range, pool }).catch(() => null),
    getComics({ userId: locals.user.id, ...range }).catch(() => null),
    getModel3ds({ userId: locals.user.id, ...range }).catch(() => null),
  ]);
  return {
    images: media ? media.filter((m) => m.type === 'image') : null,
    videos: media ? media.filter((m) => m.type === 'video') : null,
    articles,
    // Recent lists what was created in the selected period, so the list and its stats describe the same month.
    comics:
      pool === 'recent' && comics
        ? {
            ...comics,
            comics: recentInRange(comics.comics, range.from, range.to, (c) => c.projectId),
          }
        : comics,
    model3ds,
  };
};
