import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import {
  IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
  imageFeedFilterLabels,
  imageFeedSearchUnavailableKeys,
} from '~/components/Image/Infinite/image-feed-search';
import {
  useImageFeedSearchQuery,
  useImageFeedSearchSort,
  useImageFeedSimilarTo,
} from '~/components/Image/Infinite/useImageFeedSearch';
import { SearchLock, SearchSortLock, SearchSortMenu } from '~/components/Search/SearchSortLock';
import { SearchResourceFilter } from '~/components/Image/Filters/SearchResourceFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SortFilter } from '../SortFilter';

// Newest orders the best matches by date; it never widens them to every new image.
const searchSortOptions = [{ label: 'Newest matches', value: 'newest' as const }];

export function ImageFeedFilters({
  type = 'images',
  hideMediaTypes,
  hideTools,
  ...groupProps
}: GroupProps & { type?: 'images' | 'videos'; hideMediaTypes?: boolean; hideTools?: boolean }) {
  const currentUser = useCurrentUser();
  const searchQuery = useImageFeedSearchQuery();
  const similarTo = useImageFeedSimilarTo();
  const searching = !!searchQuery || !!similarTo;
  const searchSort = useImageFeedSearchSort();
  const features = useFeatureFlags();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser &&
        (searching ? (
          // The search doesn't narrow by audience, so it reads Everyone, whatever the feed's saved
          // audience is; that comes back once the search is cleared.
          <SearchLock reason="Clear the search to filter by who posted">
            <FollowedFilter
              type={type}
              variant="button"
              value="false"
              onChange={() => undefined}
              buttonProps={{ disabled: true }}
            />
          </SearchLock>
        ) : (
          <FollowedFilter type={type} variant="button" />
        ))}
      {searchQuery && searchSort.selectable ? (
        <SearchSortMenu
          sorts={searchSortOptions}
          value={searchSort.sort}
          onChange={searchSort.setSort}
        />
      ) : searching ? (
        // Without the Newest flag (and always for "more like this") the search ranks by match only; a feed sort would be a promise it
        // can't keep.
        <SearchSortLock />
      ) : (
        <SortFilter type={type} />
      )}
      {searching && features.imageSearchResources && <SearchResourceFilter />}
      <MediaFiltersDropdown
        w="100%"
        filterType={type}
        hideMediaTypes={hideMediaTypes}
        hideTools={hideTools}
        unavailable={
          searching
            ? {
                title: 'Not available while searching',
                reason: IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
                keys: imageFeedSearchUnavailableKeys,
                labels: imageFeedFilterLabels,
              }
            : undefined
        }
        isFeed
        showTags
        size="compact-sm"
      />
    </Group>
  );
}
