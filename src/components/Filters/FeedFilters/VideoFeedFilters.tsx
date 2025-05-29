import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="videos"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter type="videos" className={classes.subnavDropdown} />
      <MediaFiltersDropdown
        w="100%"
        className={classes.subnavDropdown}
        filterType="videos"
        hideMediaTypes
        size="compact-sm"
        isFeed
      />
    </Group>
  );
}
