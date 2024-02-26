import { Group, GroupProps } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
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
