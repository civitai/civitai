import { Group, GroupProps } from '@mantine/core';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="videos"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
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
