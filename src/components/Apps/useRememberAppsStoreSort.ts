import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { APPS_STORE_DEFAULTS } from '~/components/Apps/appsStoreQueryParams';
import { useAppsStoreQueryParams } from '~/components/Apps/useAppsStoreQueryParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import {
  listingSortSchema,
  type ListingSort,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Keeps the store's sort across visits: an address without a sort (every breadcrumb, back chevron
 * and nav link) takes the remembered one, and a sort in the address is remembered. Most popular
 * never shows in the URL, so the sort menu must pass its picks through the returned function.
 */
export function useRememberAppsStoreSort() {
  const router = useRouter();
  const { filters, setFilters } = useAppsStoreQueryParams();
  const stored = useFiltersContext((state) => state.appsStore.sort);
  const setStored = useFiltersContext((state) => state.setAppsStoreFilters);

  const storedRef = useRef(stored);
  storedRef.current = stored;

  const hasSortInUrl = listingSortSchema.safeParse(router.query.sort).success;

  useEffect(() => {
    if (!router.isReady) return;

    if (hasSortInUrl) {
      if (storedRef.current !== filters.sort) setStored({ sort: filters.sort });
      return;
    }

    const seed = storedRef.current;
    if (seed && seed !== APPS_STORE_DEFAULTS.sort) setFilters({ sort: seed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, filters.sort, hasSortInUrl]);

  return (sort: ListingSort) => {
    setStored({ sort });
    setFilters({ sort });
  };
}
