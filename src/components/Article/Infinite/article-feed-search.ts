import { all, first, normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';
import { QS } from '~/utils/qs';

// React-free: the /search/articles redirect reads it on the server.

/**
 * Where an old `/search/articles` URL lands now: the articles feed with the query applied. Its tags
 * are names and the feed's are ids, so they join the query, which the search matches by meaning.
 */
export function articleFeedUrlFromLegacySearch(
  params: Record<string, string | string[] | undefined>
) {
  const query = normalizeFeedQuery(
    [first(params.query), ...all(params.tags)].filter(Boolean).join(' ')
  );
  const queryString = QS.stringify({ query, username: first(params.users) });
  return queryString ? `/articles?${queryString}` : '/articles';
}
