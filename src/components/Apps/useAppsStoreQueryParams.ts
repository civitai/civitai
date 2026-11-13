import { useCallback, useEffect, useMemo } from 'react';
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
/**
 * 🔴 THE WRITE STATE IS SHARED BY EVERY INSTANCE, NOT HELD PER INSTANCE. Sort and Filters are
 * mounted by the site sub-nav and search by the store body: two instances of this hook over ONE
 * URL. With per-instance state, a sort click while the search box's debounced write was still in
 * flight merged onto a URL that did not yet carry the term, wrote the term back out as '', and
 * the box then adopted that URL: the typed term vanished without a trace.
 *
 * It is module state because what it describes, writes issued but not yet observed in
 * `router.query`, belongs to the page and not to a component. It is reset when the last instance
 * unmounts, so a stale in-flight count cannot outlive the page and override the URL on return.
 */
const shared: {
  pending: AppsStoreFilters | null;
  inFlight: number;
  lastQuery: unknown;
  mounted: number;
} = { pending: null, inFlight: 0, lastQuery: undefined, mounted: 0 };

function resetShared() {
  shared.pending = null;
  shared.inFlight = 0;
  shared.lastQuery = undefined;
}

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
   *
   * 🔴 A FUNCTION, NOT A BOOLEAN, AND THAT IS THE WHOLE POINT. It used to be
   * `isWritePending: boolean` — a value computed DURING RENDER — and that made
   * it structurally blind to the one write it most needed to mask: a write
   * issued from a SIBLING EFFECT of the very same commit. `setFilters` bumps
   * this counter in the effect phase, i.e. AFTER the render that produced the
   * boolean, so the consumer's effect closed over `false` while a write to that
   * exact field was already on its way. See the ping-pong write-up in
   * `AppListingsMarketplaceBody.tsx`. Calling it inside the effect reads the ref
   * at the moment the question is actually being asked.
   */
  hasPendingWrite: () => boolean;
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
  // (State: the module-level `shared` above, so every instance sees the same in-flight writes.)
  if (shared.lastQuery === undefined) shared.lastQuery = query;
  useEffect(() => {
    shared.mounted += 1;
    return () => {
      shared.mounted -= 1;
      if (shared.mounted === 0) resetShared();
    };
  }, []);

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
  // Shared across instances, so the first one to render a new `router.query` consumes the write
  // and the rest see it already consumed.
  if (query !== shared.lastQuery) {
    shared.lastQuery = query;
    if (shared.inFlight > 0) shared.inFlight -= 1;
    if (shared.inFlight === 0) shared.pending = null;
  }

  const filters = shared.pending ?? urlFilters;

  const setFilters = useCallback(
    (next: Partial<AppsStoreFilters>) => {
      const merged = { ...(shared.pending ?? urlFilters), ...next };
      // Set synchronously — two clicks in the same tick must both see it.
      shared.pending = merged;
      shared.inFlight += 1;
      // The COMPLETE state, not just the patch. `appsStoreFiltersToQuery` still
      // maps defaults to `undefined`, so this does not add noise to the URL — a
      // cleared filter is still removed, not re-added from the merge.
      replace(appsStoreFiltersToQuery(merged));
    },
    [replace, urlFilters]
  );

  /**
   * Stable identity (refs never change), so a consumer can hold this in a
   * dependency array — or, as the search box does, in an effect with NO
   * dependency array — without re-subscribing.
   */
  const hasPendingWrite = useCallback(() => shared.inFlight > 0, []);

  return { filters, setFilters, hasPendingWrite };
}
