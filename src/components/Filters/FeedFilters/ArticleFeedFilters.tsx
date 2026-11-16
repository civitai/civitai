import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { useFeedSearchQuery } from '~/components/Filters/FeedSearchInput';
import { SearchSortLock } from '~/components/Search/SearchSortLock';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const searching = !!useFeedSearchQuery() && !!features.articleFeedSearch;

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser && <FollowedFilter type="articles" variant="button" />}
      {searching ? <SearchSortLock /> : <SortFilter type="articles" />}
      <ArticleFiltersDropdown w="100%" size="compact-sm" />
    </Group>
  );
}
