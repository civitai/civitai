import { Group, GroupProps } from '@mantine/core';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

export function BountyFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const mobile = useContainerSmallerThan('sm');

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="bounties" variant="button" />
      <BountyFiltersDropdown size={mobile ? 'sm' : 'xs'} compact />
    </Group>
  );
}
