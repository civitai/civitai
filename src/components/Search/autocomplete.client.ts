import type { InstantSearchProps } from 'react-instantsearch';
import { autocompleteAvailability } from '~/components/Search/search-availability.store';
import { createSearchClient } from '~/components/Search/search-client-factory';

/**
 * Backs the app-wide header search (`AutocompleteSearch`).
 *
 * Unlike the other dropdown clients this one reports availability: on fallback it flips the
 * autocomplete availability flag so the dropdown can show its "Error" item. The swallowed error
 * never reaches `useInstantSearch().status`, so that store is the only channel for it.
 *
 * Lives in its own module rather than inside `AutocompleteSearch.tsx` so the wiring is
 * reachable from a node test. While it sat in the `.tsx` it was verifiable only by grepping the
 * component's source, and a source check cannot tell a guarded client that is USED from one
 * that is merely constructed — which is the whole defect.
 */
export const autocompleteSearchClient: InstantSearchProps['searchClient'] = createSearchClient({
  skipEmptyQuery: true,
  onError: () => autocompleteAvailability.setUnavailable(true),
  onSuccess: () => autocompleteAvailability.setUnavailable(false),
});
