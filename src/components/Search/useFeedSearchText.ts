import { useRouter } from 'next/router';
import { normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';

/**
 * The search text of a feed that answers `?query=` itself, read from the URL rather than the feed's
 * filter params: other pages share those params and must not pick the query up.
 */
export function useFeedSearchText(enabled: boolean) {
  const { query } = useRouter();
  return enabled && typeof query.query === 'string' ? normalizeFeedQuery(query.query) : undefined;
}
