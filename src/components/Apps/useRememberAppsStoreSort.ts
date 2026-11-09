import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { APPS_STORE_DEFAULTS } from '~/components/Apps/appsStoreQueryParams';
import { useAppsStoreQueryParams } from '~/components/Apps/useAppsStoreQueryParams';
import { useFiltersContext } from '~/providers/FiltersProvider';

/**
 * Keeps the store's sort across visits. The URL is the truth; a store opened without a `sort`
 * (every breadcrumb, back chevron and nav link is a bare `/apps/store`) takes the remembered one
 * once, and from then on the remembered value follows the URL. `popular`, the default, never
 * shows in the URL, so it is remembered too, or choosing it could never undo another sort.
 */
export function useRememberAppsStoreSort() {
  const router = useRouter();
  const { filters, setFilters } = useAppsStoreQueryParams();
  const stored = useFiltersContext((state) => state.appsStore.sort);
  const setStored = useFiltersContext((state) => state.setAppsStoreFilters);

  const storedRef = useRef(stored);
  storedRef.current = stored;
  const seeded = useRef(false);

  const hasSortInUrl = typeof router.query.sort === 'string';

  useEffect(() => {
    if (!router.isReady) return;

    if (!seeded.current) {
      seeded.current = true;
      const seed = storedRef.current;
      if (!hasSortInUrl && seed && seed !== APPS_STORE_DEFAULTS.sort) {
        setFilters({ sort: seed });
        return;
      }
    }

    if (storedRef.current !== filters.sort) setStored({ sort: filters.sort });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, filters.sort, hasSortInUrl]);
}
