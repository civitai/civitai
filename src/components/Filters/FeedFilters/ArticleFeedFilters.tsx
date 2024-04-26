import { Group, GroupProps } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="articles"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter
        type="articles"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <ArticleFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} />
    </Group>
  );
}
