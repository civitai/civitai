import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function BountyFeedFilters({ ...groupProps }: GroupProps) {
  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SortFilter type="bounties" className={classes.subnavDropdown} />
      <BountyFiltersDropdown size="compact-sm" w="100%" className={classes.subnavDropdown} />
    </Group>
  );
}
