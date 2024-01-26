import { Group, GroupProps } from '@mantine/core';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="videos" variant="button" />
      {/* // TODO.justin: adjust the background color */}
      <VideoFiltersDropdown size="sm" compact />
    </Group>
  );
}
