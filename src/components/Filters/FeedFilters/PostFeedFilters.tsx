import { Group, GroupProps } from '@mantine/core';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import { env } from '~/env/client.mjs';
import { SortFilter } from '../SortFilter';
import { ViewToggle } from '../ViewToggle';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function PostFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();
  const canToggleView = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS;

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
      {canToggleView && (
        <ViewToggle
          type="posts"
          color="gray"
          radius="xl"
          size="sm"
          iconSize={16}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        />
      )}
    </Group>
  );
}
