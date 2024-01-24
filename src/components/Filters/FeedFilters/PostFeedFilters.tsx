import { Group, GroupProps } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { ViewToggle } from '../ViewToggle';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();
  const mobile = useContainerSmallerThan('sm');

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="posts" variant="button" />
      <PostFiltersDropdown size={mobile ? 'sm' : 'xs'} compact />
      <ViewToggle
        type="posts"
        color="gray"
        radius="xl"
        size="sm"
        iconSize={mobile ? 16 : 14}
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      />
    </Group>
  );
}
