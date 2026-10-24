import type { PageServerLoad } from './$types';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getArticleLookup, resolveArticleId } from '$lib/server/article-lookup.service';

// Read-only. Both of Retool's queries were replica reads and the app took no actions, so there is
// nothing to gate beyond reaching the page.
export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  if (!q) return { q, result: null, notFound: false };

  const articleId = resolveArticleId(q);
  const result = articleId ? await getArticleLookup(articleId) : null;

  return { q, result, notFound: !result };
};
