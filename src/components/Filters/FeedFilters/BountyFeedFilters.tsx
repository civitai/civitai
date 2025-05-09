import { Group, GroupProps } from '@mantine/core';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function BountyFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SortFilter type="bounties" className={classes.subnavDropdown} />
      <BountyFiltersDropdown size="compact-sm" w="100%" className={classes.subnavDropdown} />
    </Group>
  );
}
