import { Group, GroupProps, Chip } from '@mantine/core';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { useFiltersContext } from '~/providers/FiltersProvider';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.videos,
    setFilters: state.setVideoFilters,
  }));

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <Chip
        variant="filled"
        radius="xl"
        size="sm"
        checked={filters.followed}
        classNames={{ label: classes.chipLabel }}
        onChange={(checked) => setFilters({ followed: checked })}
      >
        Followed Only
      </Chip>
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
