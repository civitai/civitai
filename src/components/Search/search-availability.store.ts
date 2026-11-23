import { create } from 'zustand';

/**
 * Tracks whether a Meili-backed search surface is currently unreachable, so the
 * UI can render a distinguishable "temporarily unavailable" / error state
 * instead of a misleading "no results found" empty state.
 *
 * The resilient search client swallows communication errors (to kill the
 * uncaught RUM exception), which means react-instantsearch's own
 * `useInstantSearch().status` never flips to `'error'`. This store is the
 * side-channel: the wrapped client flips `unavailable` on fallback and clears it
 * on the next successful search.
 *
 * Each surface gets its own store instance so an outage on one (e.g. the header
 * autocomplete) doesn't drive the error UI of another (e.g. the `/search` page).
 */
type SearchAvailabilityState = {
  unavailable: boolean;
  setUnavailable: (value: boolean) => void;
  /** The query the server last refused for profanity; cleared by the next search that runs. */
  refusedQuery: string | null;
  setRefusedQuery: (value: string | null) => void;
};

function createAvailabilityStore() {
  const useStore = create<SearchAvailabilityState>((set) => ({
    unavailable: false,
    setUnavailable: (value) =>
      // Avoid a no-op state write (and re-render) when the flag is unchanged —
      // `.search` fires on every keystroke, so `onSuccess` runs constantly.
      set((state) => (state.unavailable === value ? state : { unavailable: value })),
    refusedQuery: null,
    setRefusedQuery: (value) =>
      set((state) => (state.refusedQuery === value ? state : { refusedQuery: value })),
  }));

  return {
    useStore,
    setUnavailable: (value: boolean) => useStore.getState().setUnavailable(value),
    setRefusedQuery: (value: string | null) => useStore.getState().setRefusedQuery(value),
  };
}

// `/search` results-area banner (SearchLayout).
const searchStore = createAvailabilityStore();
export const useSearchAvailabilityStore = searchStore.useStore;
export const searchAvailability = {
  setUnavailable: searchStore.setUnavailable,
  setRefusedQuery: searchStore.setRefusedQuery,
};

// Header quick-search autocomplete dropdown error item (AutocompleteSearch).
const autocompleteStore = createAvailabilityStore();
export const useAutocompleteAvailabilityStore = autocompleteStore.useStore;
export const autocompleteAvailability = {
  setUnavailable: autocompleteStore.setUnavailable,
  setRefusedQuery: autocompleteStore.setRefusedQuery,
};
