import type { InstantSearchProps } from 'react-instantsearch';
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';
import { withUserHydration } from '~/components/Search/userHydration';
import { emptyMeiliResults } from '~/components/Search/emptySearchClient';
import { createInstantMeiliSearch } from '~/components/Search/site-search-client';

const meilisearch = createInstantMeiliSearch({ primaryKey: 'id', keepZeroFacets: true });

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
      return Promise.resolve(emptyMeiliResults(requests));
    }

    return meilisearch.search(requests);
  },
};

// Wrap so a Meili outage degrades to empty results instead of an uncaught
// `MeiliSearchCommunicationError`. This client backs the header quick-search
// dropdown (and other autocomplete surfaces), so it fails quietly — no banner.
export const searchClient: InstantSearchProps['searchClient'] = withUserHydration(
  createResilientSearchClient(baseSearchClient)
);
