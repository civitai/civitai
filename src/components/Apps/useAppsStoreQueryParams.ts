import { useCallback, useMemo } from 'react';
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
} {
  const { query, replace } = useZodRouteParams(appsStoreQuerySchema);

  const filters = useMemo(() => resolveAppsStoreFilters(query), [query]);

  const setFilters = useCallback(
    (next: Partial<AppsStoreFilters>) => {
      replace(appsStoreFiltersToQuery(next));
    },
    [replace]
  );

  return { filters, setFilters };
}
