import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { AppsStoreFiltersDropdown } from '~/components/Apps/AppsStoreFiltersDropdown';
import { useRememberAppsStoreSort } from '~/components/Apps/useRememberAppsStoreSort';
import { useAppsStoreQueryParams } from '~/components/Apps/useAppsStoreQueryParams';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type { ListingSort } from '~/server/schema/blocks/app-listing-read.schema';

const SORT_OPTIONS: { value: ListingSort; label: string }[] = [
  { value: 'top-rated', label: 'Top rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

/**
 * `/apps/store` sort + filters, rendered in the site sub-nav the way the images feed does
 * (`ImageFeedFilters`): the `SelectMenuV2` sort button and the shared Filters dropdown.
 * State is the URL (`useAppsStoreQueryParams`), so the store body reads the same values
 * without any lifted state.
 */
export function AppsStoreFeedFilters(groupProps: GroupProps) {
  const { filters, setFilters } = useAppsStoreQueryParams();
  const { kind, category, sort } = filters;
  const chooseSort = useRememberAppsStoreSort();

  return (
    // Full width on mobile, like every other feed: `SubNav2` puts the gear on this same row.
    <Group
      className={classes.filtersWrapper}
      gap={8}
      wrap="nowrap"
      data-testid="apps-store-feed-filters"
      {...groupProps}
    >
      <SelectMenuV2
        label={SORT_OPTIONS.find((o) => o.value === sort)?.label ?? sort}
        value={sort}
        options={SORT_OPTIONS}
        onClick={chooseSort}
      />
      <AppsStoreFiltersDropdown filters={{ kind, category }} onChange={setFilters} />
    </Group>
  );
}
