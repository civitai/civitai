import { ActionIcon, Button, Group, GroupProps, Popover, Chip } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';

import { SortFilter } from '~/components/Filters';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PeriodMode } from '~/server/schema/base.schema';

export function ModelFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const { set, ...queryFilters } = useModelQueryParams();
  const { setFilters, filters } = useFiltersContext((state) => ({
    filters: state.models,
    setFilters: state.setModelFilters,
  }));
  const { favorites, query } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;

  return (
    <Group className={classes.filtersWrapper} spacing={4} noWrap {...groupProps}>
      {periodMode && (
        <Popover>
          <Popover.Target>
            <ActionIcon variant="filled" color="blue" radius="xl" size={36} mr={4}>
              <IconExclamationMark size={20} strokeWidth={3} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown maw={300}>
            {`To ensure that you see all possible results, we've disabled the period filter.`}
            <Button mt="xs" size="xs" fullWidth onClick={() => set({ query: undefined })}>
              Clear Search
            </Button>
          </Popover.Dropdown>
        </Popover>
      )}

      <Chip
        checked={filters.followed}
        classNames={{ label: classes.chipLabel }}
        onChange={(checked) => setFilters({ followed: checked })}
        variant="filled"
        radius="xl"
        size="sm"
      >
        Followed Only
      </Chip>
      <SortFilter
        type="models"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <ModelFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} isFeed />
    </Group>
  );
}
