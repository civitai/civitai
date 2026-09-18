import type { InstantSearchProps } from 'react-instantsearch';
import { createSearchClient } from '~/components/Search/search-client-factory';

/**
 * Backs `QuickSearchDropdown`'s default branch.
 *
 * No empty-query short-circuit: this dropdown is used with a `startingIndex` and a caller
 * `filters` prop to offer candidates before anything is typed. Fails quietly (no banner).
 */
export const quickSearchClient: InstantSearchProps['searchClient'] = createSearchClient();
