import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { useRouter } from 'next/router';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import {
  STORYLINE_FEED_FILTERS,
  StorylineFiltersDropdown,
} from '~/components/Storyline/StorylineFiltersDropdown';
import type { StorylineFeedFilter } from '~/components/Storyline/StorylineFiltersDropdown';

export const STORYLINE_FEED_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'mostChapters', label: 'Most chapters' },
] as const;

export type StorylineFeedSort = (typeof STORYLINE_FEED_SORTS)[number]['value'];

/**
 * The feed's sort and filter, kept in the URL so the sub-nav's menus and the page's feed share
 * them. A value the URL does not name is the default.
 */
export function useStorylineFeedParams() {
  const router = useRouter();
  const sort: StorylineFeedSort =
    STORYLINE_FEED_SORTS.find((s) => s.value === router.query.sort)?.value ?? 'newest';
  const filter: StorylineFeedFilter =
    STORYLINE_FEED_FILTERS.find((f) => f.value === router.query.filter)?.value ?? 'all';

  const setParam = (key: 'sort' | 'filter', value: string, fallback: string) => {
    const query = { ...router.query };
    if (value === fallback) delete query[key];
    else query[key] = value;
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  return {
    sort,
    filter,
    setSort: (next: StorylineFeedSort) => setParam('sort', next, 'newest'),
    setFilter: (next: StorylineFeedFilter) => setParam('filter', next, 'all'),
  };
}

export function StorylinesFeedControls({
  sort,
  onSort,
  filter,
  onFilter,
  ...groupProps
}: {
  sort: StorylineFeedSort;
  onSort: (sort: StorylineFeedSort) => void;
  filter: StorylineFeedFilter;
  onFilter: (filter: StorylineFeedFilter) => void;
} & GroupProps) {
  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SelectMenuV2
        label={STORYLINE_FEED_SORTS.find((s) => s.value === sort)?.label ?? sort}
        value={sort}
        onClick={onSort}
        options={[...STORYLINE_FEED_SORTS]}
      />
      <StorylineFiltersDropdown value={filter} onChange={onFilter} />
    </Group>
  );
}

/** The /storylines menus, in the sub-nav like every other feed's. */
export function StorylineFeedFilters(groupProps: GroupProps) {
  const { sort, filter, setSort, setFilter } = useStorylineFeedParams();
  return (
    <StorylinesFeedControls
      sort={sort}
      onSort={setSort}
      filter={filter}
      onFilter={setFilter}
      {...groupProps}
    />
  );
}
