import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { env } from '~/env/client';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

// The empty `SearchResponse` shape `@meilisearch/instant-meilisearch` / `react-instantsearch`
// expect — one entry per request, no hits. Shared so the three clients that return it (this
// always-empty one, plus the conditional-empty branches in `search.client.ts` and
// `AutocompleteSearch`) stay in step if the response type ever gains a field.
export function emptyMeiliResults(requests: readonly unknown[]) {
  return {
    results: requests.map(() => ({
      hits: [],
      nbHits: 0,
      nbPages: 0,
      page: 0,
      processingTimeMS: 0,
      hitsPerPage: 0,
      exhaustiveNbHits: false,
      query: '',
      params: '',
    })),
  };
}

// Resolves every request to an empty result set without a network round-trip. Used for indexes
// that must not be queried — image search while the images_v6 index is retired for maintenance —
// so the surrounding search UI can render its chrome without hitting a backing index that no
// longer exists.
export const emptySearchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    return Promise.resolve(emptyMeiliResults(requests));
  },
};
