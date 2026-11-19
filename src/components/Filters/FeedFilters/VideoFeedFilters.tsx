import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { ImageFeedFilters } from '~/components/Filters/FeedFilters/ImageFeedFilters';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SortFilter } from '../SortFilter';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

export function VideoFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  // Searchable, the videos feed takes the images feed's bar: its sort and filters while searching.
  if (features.videoFeedSearch && features.feedSearch)
    return <ImageFeedFilters type="videos" hideMediaTypes {...groupProps} />;

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser && <FollowedFilter type="videos" variant="button" />}
      <SortFilter type="videos" />
      <MediaFiltersDropdown w="100%" filterType="videos" hideMediaTypes size="compact-sm" isFeed />
    </Group>
  );
}
