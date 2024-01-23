import { Group, GroupProps } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { ViewToggle } from '../ViewToggle';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="posts" variant="button" />
      <PostFiltersDropdown />
      <ViewToggle
        type="posts"
        color="gray"
        radius="xl"
        size={36}
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      />
    </Group>
  );
}
