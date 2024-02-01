import { Group, GroupProps } from '@mantine/core';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter
        type="videos"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <VideoFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} isFeed />
    </Group>
  );
}
