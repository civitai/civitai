import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { useFeedSearchQuery } from '~/components/Filters/FeedSearchInput';
import { SearchSortLock } from '~/components/Search/SearchSortLock';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBountyQueryParams } from '~/components/Bounty/bounty.utils';

export function BountyFeedFilters({ ...groupProps }: GroupProps) {
  const features = useFeatureFlags();
  const { query } = useBountyQueryParams();
  // The page searches only its plain feed, not an engagement view (see pages/bounties).
  const searching = !!useFeedSearchQuery() && !!features.semanticBountySearch && !query.engagement;
  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {searching ? <SearchSortLock /> : <SortFilter type="bounties" />}
      <BountyFiltersDropdown size="compact-sm" w="100%" />
    </Group>
  );
}
