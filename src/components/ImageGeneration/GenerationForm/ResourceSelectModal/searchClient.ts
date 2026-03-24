import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { env } from '~/env/client';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    return meilisearch.search(requests);
  },
};
