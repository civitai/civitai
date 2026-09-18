import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import type { InstantSearchProps } from 'react-instantsearch';
import type { SearchRequests } from '~/components/Search/resilientSearchClient';
import {
  createResilientSearchClient,
  emptySearchResults,
} from '~/components/Search/resilientSearchClient';
import { withSearchFilterGuard } from '~/components/Search/searchFilterGuard';
import { withUserHydration } from '~/components/Search/userHydration';
import { env } from '~/env/client';

/**
 * One place that assembles a browser search client, so the wrapper stack is a single decision
 * rather than one re-made per surface.
 *
 * It used to be three hand-rolled compositions. They had already drifted — the same 18-line
 * empty-query short-circuit copied byte-for-byte into two of them and absent from the third —
 * and the drift that matters is the one nobody would notice: a wrapper added to two of three
 * call sites leaves the third silently unprotected, which is exactly the shape of the defect
 * `withSearchFilterGuard` exists to fix.
 *
 * Order, outermost first, and each layer depends on the one under it:
 *   `withUserHydration`         — replaces stale denormalized avatars; needs a settled response.
 *   `createResilientSearchClient` — turns a backend blip into empty results + the availability
 *                                 callbacks. Sits OUTSIDE the guard so a locally-rejected
 *                                 request counts as a success and never raises the "search is
 *                                 unavailable" banner: search was reachable, our filter was wrong.
 *   empty-query short-circuit   — optional; suppresses the round trip when nothing was typed.
 *   `withSearchFilterGuard`     — drops a request whose filters cannot apply to its index.
 *
 * 🔴 `SearchLayout` and `CollectionSelectModal` deliberately do NOT use this factory and build
 * their own clients: the first carries `key={indexName}`, the second targets a constant index,
 * so neither can leak a filter set across an index switch and neither needs the guard. That
 * exclusion is asserted in `__tests__/search-client-filter-guard.test.ts`, which fails if a new
 * `instantMeiliSearch(` call site appears without being classified.
 */
export function createSearchClient({
  keepZeroFacets = false,
  skipEmptyQuery = false,
  onError,
  onSuccess,
}: {
  /** Meili option — keep facet entries whose count is 0. */
  keepZeroFacets?: boolean;
  /** Resolve to empty results without a round trip when no request in the batch has a query. */
  skipEmptyQuery?: boolean;
  /** Raised when a search falls back for anything other than a locally-rejected filter. */
  onError?: (error: unknown) => void;
  /** Raised on every successful search — lets a caller clear a prior "unavailable" state. */
  onSuccess?: () => void;
} = {}): InstantSearchProps['searchClient'] {
  const meilisearch = instantMeiliSearch(
    env.NEXT_PUBLIC_SEARCH_HOST as string,
    env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
    { primaryKey: 'id', ...(keepZeroFacets ? { keepZeroFacets: true } : {}) }
  );

  const guarded = withSearchFilterGuard(meilisearch);

  const base = skipEmptyQuery
    ? {
        ...meilisearch,
        search(requests: SearchRequests) {
          // Prevent making a request if there is no query
          // @see https://www.algolia.com/doc/guides/building-search-ui/going-further/conditional-requests/react/#detecting-empty-search-requests
          // @see https://github.com/algolia/react-instantsearch/issues/1111#issuecomment-496132977
          if (requests.every(({ params }) => !params?.query)) {
            return Promise.resolve(emptySearchResults(requests));
          }
          return guarded.search(requests);
        },
      }
    : guarded;

  return withUserHydration(createResilientSearchClient(base, { onError, onSuccess }));
}
