import { create } from 'zustand';

/**
 * Tracks whether the Meili-backed search is currently unreachable, so the
 * `/search` results area can render a distinguishable "temporarily unavailable"
 * banner instead of a misleading "no results found" empty state.
 *
 * The resilient search client swallows communication errors (to kill the
 * uncaught RUM exception), which means react-instantsearch's own
 * `useInstantSearch().status` never flips to `'error'`. This store is the
 * side-channel: the wrapped client flips `unavailable` on fallback and clears it
 * on the next successful search.
 */
type SearchAvailabilityState = {
  unavailable: boolean;
  setUnavailable: (value: boolean) => void;
};

export const useSearchAvailabilityStore = create<SearchAvailabilityState>((set) => ({
  unavailable: false,
  setUnavailable: (value) =>
    // Avoid a no-op state write (and re-render) when the flag is unchanged —
    // `.search` fires on every keystroke, so `onSuccess` runs constantly.
    set((state) => (state.unavailable === value ? state : { unavailable: value })),
}));

export const searchAvailability = {
  setUnavailable: (value: boolean) =>
    useSearchAvailabilityStore.getState().setUnavailable(value),
};
