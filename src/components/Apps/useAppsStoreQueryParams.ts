import { useCallback, useMemo, useRef } from 'react';
import {
  appsStoreFiltersToQuery,
  appsStoreQuerySchema,
  resolveAppsStoreFilters,
  type AppsStoreFilters,
} from '~/components/Apps/appsStoreQueryParams';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';

/**
 * `/apps` store filter state, read from and written to the URL query string.
 *
 * The React-facing half of `appsStoreQueryParams.ts` (which holds every actual
 * decision, React-free, so the node `unit` project can cover it). This file is
 * deliberately thin — it is the piece that cannot be unit-tested without a
 * router, so it should contain as little judgement as possible.
 *
 * Built on the repo's shared {@link useZodRouteParams}, the same hook
 * `useModelQueryParams2` uses, which gives us for free:
 *   - `router.replace` with `{ shallow: true, scroll: false }` — a filter change
 *     does NOT re-run `getServerSideProps` and does NOT jump the viewport to the
 *     top mid-browse;
 *   - `removeEmpty` over the merged query, so the `undefined`s that
 *     `appsStoreFiltersToQuery` emits for default values drop out of the URL
 *     instead of appearing as empty params.
 *
 * 🔴 Reads NOTHING but `router.query`. See the hydration note in
 * `appsStoreQueryParams.ts` — this is the boundary where a client-only source
 * (`window.location`, `localStorage`, a media query) would re-create the
 * hydration bail that left every `/apps` page inert.
 */
export function useAppsStoreQueryParams(): {
  filters: AppsStoreFilters;
  /** Patch one or more filters; omitted keys are untouched. */
  setFilters: (next: Partial<AppsStoreFilters>) => void;
  /**
   * True while a write we issued has not yet been observed in `router.query`.
   *
   * Exposed because a consumer holding LOCAL state that mirrors a filter (the
   * search box) cannot otherwise tell "the URL disagrees because my own write is
   * still in flight" from "the URL disagrees because the viewer pressed Back".
   * Both look identical from a `useEffect` on `filters.query` — and worse, React
   * can coalesce our write's render away entirely, so the URL value never even
   * appears to CHANGE and a dependency-array effect never fires. That is the
   * exact shape of the stale-search bug.
   */
  isWritePending: boolean;
} {
  const { query, replace } = useZodRouteParams(appsStoreQuerySchema);

  const urlFilters = useMemo(() => resolveAppsStoreFilters(query), [query]);

  /**
   * 🔴 THE IN-FLIGHT WRITE. `useZodRouteParams` builds every write as
   * `schema.parse({ ...query, ...params })`, where `query` is MEMOISED on
   * `router.query` — and `router.replace` is asynchronous. So a second filter
   * click inside the first replace's in-flight window merges its patch against
   * the STALE snapshot, and the first selection silently vanishes from the URL.
   * Because the panel now renders FROM the URL, the viewer watches their first
   * choice revert. These were plain `useState` before this PR, so this is a
   * failure mode the URL move INTRODUCED.
   *
   * Two halves to the fix:
   *   1. `pendingRef` holds the state we last SENT, so a rapid second click
   *      merges onto that rather than onto the not-yet-applied URL;
   *   2. every write emits ALL FOUR fields (see `setFilters`), so the stale
   *      `{...query}` spread inside `useZodRouteParams` can no longer contribute
   *      a stale value for any field we own. Params we do NOT own (utm_*, ref)
   *      still ride along from the snapshot, which is correct — they don't change
   *      during our writes.
   *
   * 🔴 Deliberately NOT fixed in `useZodRouteParams` itself: that hook is shared
   * with `/models` and changing its merge semantics would silently alter a
   * surface this PR has not tested. The work-around is local; the underlying
   * sharp edge in the shared hook is flagged in the PR.
   */
  const pendingRef = useRef<AppsStoreFilters | null>(null);
  /** Writes issued but not yet observed arriving in `router.query`. */
  const inFlightRef = useRef(0);
  const lastQueryRef = useRef(query);

  /**
   * 🔴 THE IN-FLIGHT WINDOW IS COUNTED, NOT COMPARED — and both value-comparing
   * versions I tried were wrong, in ways only a test caught.
   *
   * v1 cleared `pending` once `urlFilters` EQUALLED what we sent. React can
   * coalesce our own write's render away, so the URL can go
   * base -> ours -> (Back) -> elsewhere with one render in between; `pending`
   * never matched, never cleared, and kept overriding the real URL. It went
   * green the moment a `console.log` slowed the renders apart — a guard whose
   * correctness depends on render timing is not a guard.
   *
   * v2 cleared `pending` when `urlFilters` differed from the PRE-WRITE snapshot.
   * That is timing-independent but still wrong for the commonest case: pressing
   * Back after a search returns the URL to EXACTLY the pre-write value, so it is
   * indistinguishable from "our write has not landed yet". The box stayed stale.
   *
   * Counting sidesteps both. Every write increments; every observed change of
   * the `router.query` REFERENCE consumes one, whatever its value. At zero the
   * URL is authoritative again. Two rapid clicks keep the count above zero
   * across the first arrival, so the second click still merges onto our own
   * state; a Back drops it to zero and `urlFilters` wins — even when the value
   * it lands on happens to equal where we started.
   */
  if (query !== lastQueryRef.current) {
    lastQueryRef.current = query;
    if (inFlightRef.current > 0) inFlightRef.current -= 1;
    if (inFlightRef.current === 0) pendingRef.current = null;
  }

  const filters = pendingRef.current ?? urlFilters;

  const setFilters = useCallback(
    (next: Partial<AppsStoreFilters>) => {
      const merged = { ...(pendingRef.current ?? urlFilters), ...next };
      // Set synchronously — two clicks in the same tick must both see it.
      pendingRef.current = merged;
      inFlightRef.current += 1;
      // The COMPLETE state, not just the patch. `appsStoreFiltersToQuery` still
      // maps defaults to `undefined`, so this does not add noise to the URL — a
      // cleared filter is still removed, not re-added from the merge.
      replace(appsStoreFiltersToQuery(merged));
    },
    [replace, urlFilters]
  );

  return { filters, setFilters, isWritePending: inFlightRef.current > 0 };
}
