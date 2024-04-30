import { Group, GroupProps } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="posts"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter
        type="posts"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <PostFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} />
    </Group>
  );
}
