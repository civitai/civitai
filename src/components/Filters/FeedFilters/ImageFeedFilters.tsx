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
import { SearchLock, SearchSortLock } from '~/components/Search/SearchSortLock';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';

// Newest orders the best matches by date; it never widens them to every new image.
const searchSortOptions = [
  { label: 'Best match', value: 'best-match' },
  { label: 'Newest matches', value: 'newest' },
];

export function ImageFeedFilters({
  hideMediaTypes,
  hideTools,
  ...groupProps
}: GroupProps & { hideMediaTypes?: boolean; hideTools?: boolean }) {
  const currentUser = useCurrentUser();
  const searchQuery = useImageFeedSearchQuery();
  const similarTo = useImageFeedSimilarTo();
  const searching = !!searchQuery || !!similarTo;
  const searchSort = useImageFeedSearchSort();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser &&
        (searching ? (
          // The search doesn't narrow by audience, so it reads Everyone, whatever the feed's saved
          // audience is; that comes back once the search is cleared.
          <SearchLock reason="Clear the search to filter by who posted">
            <FollowedFilter
              type="images"
              variant="button"
              value="false"
              onChange={() => undefined}
              buttonProps={{ disabled: true }}
            />
          </SearchLock>
        ) : (
          <FollowedFilter type="images" variant="button" />
        ))}
      {searchQuery && searchSort.selectable ? (
        <SelectMenuV2
          label={searchSort.sort === 'newest' ? 'Newest matches' : 'Best match'}
          value={searchSort.sort ?? 'best-match'}
          options={searchSortOptions}
          onClick={(value) => searchSort.setSort(value === 'newest' ? value : undefined)}
        />
      ) : searching ? (
        // Without the Newest flag (and always for "more like this") the search ranks by match only; a feed sort would be a promise it
        // can't keep.
        <SearchSortLock />
      ) : (
        <SortFilter type="images" />
      )}
      <MediaFiltersDropdown
        w="100%"
        filterType="images"
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
