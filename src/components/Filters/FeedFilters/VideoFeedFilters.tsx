import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

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
      <SortFilter type="videos" className={classes.subnavDropdown} />
      <MediaFiltersDropdown
        size="sm"
        w="100%"
        className={classes.subnavDropdown}
        filterType="videos"
        hideMediaTypes
        compact
        isFeed
      />
    </Group>
  );
}
