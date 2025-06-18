import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser && <FollowedFilter type="articles" variant="button" />}
      <SortFilter type="articles" />
      <ArticleFiltersDropdown w="100%" size="compact-sm" />
    </Group>
  );
}
