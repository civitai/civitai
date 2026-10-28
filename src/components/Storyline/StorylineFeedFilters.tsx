import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import {
  STORYLINE_FEED_FILTERS,
  StorylineFiltersDropdown,
} from '~/components/Storyline/StorylineFiltersDropdown';
import type { StorylineFeedFilter } from '~/components/Storyline/StorylineFiltersDropdown';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import * as z from 'zod';

export const STORYLINE_FEED_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'mostChapters', label: 'Most chapters' },
] as const;

export type StorylineFeedSort = (typeof STORYLINE_FEED_SORTS)[number]['value'];

// Each field falls back on its own, so one unknown value does not drop the other.
const storylineFeedParamsSchema = z.object({
  sort: z
    .enum(STORYLINE_FEED_SORTS.map((s) => s.value) as [StorylineFeedSort, ...StorylineFeedSort[]])
    .optional()
    .catch(undefined),
  filter: z
    .enum(
      STORYLINE_FEED_FILTERS.map((f) => f.value) as [StorylineFeedFilter, ...StorylineFeedFilter[]]
    )
    .optional()
    .catch(undefined),
});

/**
 * The feed's sort and filter, kept in the URL so the sub-nav's menus and the page's feed share
 * them. A default is left out of the URL.
 */
export function useStorylineFeedParams() {
  const { query, replace } = useZodRouteParams(storylineFeedParamsSchema);
  return {
    sort: query.sort ?? 'newest',
    filter: query.filter ?? 'all',
    setSort: (sort: StorylineFeedSort) => replace({ sort: sort === 'newest' ? undefined : sort }),
    setFilter: (filter: StorylineFeedFilter) =>
      replace({ filter: filter === 'all' ? undefined : filter }),
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
