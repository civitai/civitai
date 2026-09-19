import type { MutableRefObject } from 'react';
import { useCallback, useState } from 'react';

/**
 * Carries the text a user has typed across the remount that an index switch causes.
 *
 * Both dropdown search roots key `<InstantSearch>` on the resolved index name, the way
 * `SearchLayout` already does. That key is what keeps a search from firing with the PREVIOUS
 * index's parameters: react-instantsearch-core calls `helper.setIndex(indexName).search()` in its
 * RENDER body, and `<InstantSearch>` renders before the children that own the query parameters, so
 * without the key a target switch searches the new index with the old target's `filters`. Keying it
 * builds a fresh helper instead, and the children mount their parameters onto it before it searches.
 *
 * The cost of the key is that the typed text lives INSIDE that subtree, so a remount would wipe it.
 * `carriedRef` is owned by the component that renders `<InstantSearch>` — above the keyed boundary,
 * so it survives — and this hook seeds the remounted input from it and keeps it written.
 *
 * `refinedQuery` is the search helper's own query. It is only the seed on a FIRST mount: a freshly
 * built helper reports `''`, so a remount that carries text seeds a value that differs from it, and
 * that difference is what makes each component's existing "push the text into the helper" effect
 * fire again. That is what re-RUNS the search on the new index rather than only re-displaying the
 * text.
 *
 * @returns three things: the current text; a setter that writes the carrier as well as the state;
 *   and a display-only clear that empties the visible text and LEAVES the carrier alone.
 *
 *   Every write of a value goes through the setter — a bare `setState` would leave the carrier
 *   holding stale text, which the next remount would restore over the newer value.
 *
 *   The display-only clear is the deliberate exception, and it exists for one caller: the blur
 *   handler on `AutocompleteSearch`'s input. Clicking the category selector blurs that input, so a
 *   blur that wrote `''` through the setter would empty the carrier a moment BEFORE the switch it
 *   is meant to survive — which is what made the carry inert on that component. A blur is the
 *   browser moving focus, not the user asking to discard what they typed; an explicit clear (the
 *   input's clear button) still goes through the setter and does discard it.
 *
 *   The cost is a window where the input reads empty while the carrier still holds text, so the
 *   NEXT remount re-seeds text the user last saw cleared. The owner of `carriedRef` is what bounds
 *   that window: `AutocompleteSearch` empties the ref itself when a navigation — rather than a pick
 *   from the selector — changes the target, so only a selector-driven remount re-seeds.
 */
export function useCarriedSearchText(
  carriedRef: MutableRefObject<string>,
  refinedQuery: string
): [string, (value: string) => void, () => void] {
  const [text, setText] = useState(() => seedCarriedSearchText(carriedRef.current, refinedQuery));

  const write = useCallback(
    (value: string) => {
      carriedRef.current = value;
      setText(value);
    },
    [carriedRef]
  );

  const clearDisplayedText = useCallback(() => setText(''), []);

  return [text, write, clearDisplayedText];
}

/**
 * What a mounting input starts with. Carried text wins; an empty carrier falls back to the helper's
 * own query, which is the behaviour a first mount had before the carrier existed.
 */
export function seedCarriedSearchText(carried: string | undefined, refinedQuery: string): string {
  return carried ? carried : refinedQuery;
}

/**
 * Whether the mounted tree still owes its text to the search helper — the decision both dropdowns'
 * "push the text into the helper" effects make.
 *
 * This is what turns a remount into a re-RUN of the search rather than a re-display of the text: a
 * rebuilt helper reports an empty query, so carried text differs from it and gets pushed.
 *
 * @param blocked reasons not to refine at all — a hit was picked from the list, or search is
 *   unavailable. 🔴 A source of `blocked` that OUTLIVES the remount must appear in the calling
 *   effect's dependency array, or a tree that remounted while blocked restores the typed text,
 *   returns early, and never refines once the block clears — a populated input over an empty
 *   helper query. `searchErrorState` is such a source (a module-level store) and is listed.
 *   A source that is per-mount state is reset by the remount, so leaving it out cannot produce
 *   THAT failure; `AutocompleteSearch`'s `selectedItem` is one, and is left out. ⚠️ Read narrowly
 *   — this is not a blessing. Omitting a per-mount source still costs the refine cycle in which
 *   it is stale: after a hit is picked, the next text change evaluates the guard against the old
 *   `selectedItem` and skips one refine. Pre-existing there, and not something to reproduce.
 */
export function shouldRefineSearchQuery(
  typed: string,
  refinedQuery: string,
  blocked = false
): boolean {
  return !blocked && typed !== refinedQuery;
}
