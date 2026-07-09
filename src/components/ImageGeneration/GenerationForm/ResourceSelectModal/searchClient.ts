import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { env } from '~/env/client';
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

// Wrapped so a Meili outage degrades to empty results instead of an uncaught
// `MeiliSearchCommunicationError`. Fails quietly (modal picker, no banner).
export const searchClient: InstantSearchProps['searchClient'] = createResilientSearchClient({
  ...meilisearch,
  search(requests) {
    return meilisearch.search(requests);
  },
});
