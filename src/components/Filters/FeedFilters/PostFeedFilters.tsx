import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="posts"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter type="posts" className={classes.subnavDropdown} />
      <PostFiltersDropdown w="100%" size="compact-sm" className={classes.subnavDropdown} />
    </Group>
  );
}
