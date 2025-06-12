import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { ToolFiltersDropdown } from '~/components/Tool/ToolFiltersDropdown';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function ToolFeedFilters({ ...groupProps }: GroupProps) {
  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SortFilter type="tools" />
      <ToolFiltersDropdown w="100%" size="compact-sm" />
    </Group>
  );
}
