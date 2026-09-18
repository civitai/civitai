import type { InstantSearchProps } from 'react-instantsearch';
import { createSearchClient } from '~/components/Search/search-client-factory';

/**
 * Backs `QuickSearchDropdown`'s `disableInitialSearch` branch — its only consumer.
 *
 * Fails quietly (no availability banner): this is a small dropdown, not the search page.
 */
export const searchClient: InstantSearchProps['searchClient'] = createSearchClient({
  keepZeroFacets: true,
  skipEmptyQuery: true,
});
