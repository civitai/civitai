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
 * @returns the current text, and a setter that writes the carrier as well as the state. Every write
 *   has to go through that setter — a bare `setState` leaves the carrier holding stale text, which
 *   the next remount would then restore over the newer value.
 */
export function useCarriedSearchText(
  carriedRef: MutableRefObject<string>,
  refinedQuery: string
): [string, (value: string) => void] {
  const [text, setText] = useState(() => seedCarriedSearchText(carriedRef.current, refinedQuery));

  const write = useCallback(
    (value: string) => {
      carriedRef.current = value;
      setText(value);
    },
    [carriedRef]
  );

  return [text, write];
}

/**
 * What a mounting input starts with. Carried text wins; an empty carrier falls back to the helper's
 * own query, which is the behaviour a first mount had before the carrier existed.
 */
export function seedCarriedSearchText(carried: string | undefined, refinedQuery: string): string {
  return carried ? carried : refinedQuery;
}
