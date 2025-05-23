import { Group, GroupProps } from '@mantine/core';
import { ToolFiltersDropdown } from '~/components/Tool/ToolFiltersDropdown';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function ToolFeedFilters({ ...groupProps }: GroupProps) {
  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SortFilter type="tools" className={classes.subnavDropdown} />
      <ToolFiltersDropdown w="100%" size="compact-sm" className={classes.subnavDropdown} />
    </Group>
  );
}
