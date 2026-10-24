import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getArticleViewDetail } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, params, cookies }) => {
  const articleId = Number(params.articleId);
  if (!Number.isInteger(articleId) || articleId <= 0) throw error(400, 'Invalid article id');
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;

  // Ownership is enforced inside the read; a miss is indistinguishable from a deleted article by design.
  const [article, compareDetail] = await Promise.all([
    getArticleViewDetail({
      userId: locals.user.id,
      articleId,
      ...range,
      compareFrom: compare.from,
      compareTo: compare.to,
    }),
    getArticleViewDetail({
      userId: locals.user.id,
      articleId,
      ...compare,
      compareFrom: compare.from,
      compareTo: compare.to,
    }).catch(() => null),
  ]);
  if (!article) throw error(404, 'Article not found, or not yours');

  return { article, compareSeries: compareDetail?.series ?? [] };
};
