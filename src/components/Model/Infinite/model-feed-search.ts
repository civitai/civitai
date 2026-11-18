import { all, first, normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';
import { QS } from '~/utils/qs';

// React-free: the /search/models redirect reads it on the server.

/**
 * Where an old `/search/models` URL lands now: the models feed with the query applied. Tags and
 * categories have no feed filter that takes several, so their names join the query, which the
 * search matches by meaning.
 */
export function modelFeedUrlFromLegacySearch(
  params: Record<string, string | string[] | undefined>
) {
  const query = normalizeFeedQuery(
    [first(params.query), ...all(params.tags), ...all(params.category)].filter(Boolean).join(' ')
  );
  const queryString = QS.stringify({
    query,
    username: first(params.users),
    baseModels: all(params.baseModel),
    types: all(params.modelType),
    checkpointType: first(params.checkpointType),
  });
  return queryString ? `/models?${queryString}` : '/models';
}
