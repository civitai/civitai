import { Group, GroupProps } from '@mantine/core';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const mobile = useContainerSmallerThan('sm');

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="videos" variant="button" />
      <VideoFiltersDropdown size={mobile ? 'sm' : 'xs'} compact />
    </Group>
  );
}
