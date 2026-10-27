import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { AppsStoreFiltersDropdown } from '~/components/Apps/AppsStoreFiltersDropdown';
import { useAppsStoreQueryParams } from '~/components/Apps/useAppsStoreQueryParams';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type { ListingSort } from '~/server/schema/blocks/app-listing-read.schema';

const SORT_OPTIONS: { value: ListingSort; label: string }[] = [
  { value: 'top-rated', label: 'Top rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

/**
 * `/apps` sort + filters, rendered in the site sub-nav the way the images feed does
 * (`ImageFeedFilters`): the `SelectMenuV2` sort button and the shared Filters dropdown.
 * State is the URL (`useAppsStoreQueryParams`), so the store body reads the same values
 * without any lifted state.
 */
export function AppsStoreFeedFilters(groupProps: GroupProps) {
  const { filters, setFilters } = useAppsStoreQueryParams();
  const { kind, category, sort } = filters;

  return (
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
        onClick={(value) => setFilters({ sort: value })}
      />
      <AppsStoreFiltersDropdown filters={{ kind, category }} onChange={setFilters} />
    </Group>
  );
}
