import { Group, GroupProps } from '@mantine/core';
import { ToolFiltersDropdown } from '~/components/Tool/ToolFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function ToolFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="tools" className={classes.subnavDropdown} />
      <ToolFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} />
    </Group>
  );
}
