import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { env } from '~/env/client';
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const baseSearchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    // Prevent making a request if there is no query
    // @see https://www.algolia.com/doc/guides/building-search-ui/going-further/conditional-requests/react/#detecting-empty-search-requests
    // @see https://github.com/algolia/react-instantsearch/issues/1111#issuecomment-496132977
    if (
      requests.every(({ params }) => !params?.query)
      // && !location.pathname.startsWith('/search')
    ) {
      return Promise.resolve({
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
      });
    }

    return meilisearch.search(requests);
  },
};

// Wrap so a Meili outage degrades to empty results instead of an uncaught
// `MeiliSearchCommunicationError`. This client backs the header quick-search
// dropdown (and other autocomplete surfaces), so it fails quietly — no banner.
export const searchClient: InstantSearchProps['searchClient'] =
  createResilientSearchClient(baseSearchClient);
