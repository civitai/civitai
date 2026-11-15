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
} from '~/components/Image/Infinite/useImageFeedSearch';
import { Tooltip } from '~/components/MantineOverlays';
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
  const searchSort = useImageFeedSearchSort();

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {currentUser &&
        (searchQuery ? (
          // The search doesn't narrow by audience, so the selector waits until it's cleared.
          <Tooltip label="Clear the search to filter by who posted" withArrow>
            <div>
              <FollowedFilter type="images" variant="button" buttonProps={{ disabled: true }} />
            </div>
          </Tooltip>
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
      ) : searchQuery ? (
        // Without the Newest flag the search ranks by match only; a feed sort would be a promise it
        // can't keep.
        <Tooltip label="Clear the search to sort the feed" withArrow>
          <div>
            <SelectMenuV2
              label="Best match"
              value="best-match"
              options={[{ label: 'Best match', value: 'best-match' }]}
              onClick={() => undefined}
              disabled
            />
          </div>
        </Tooltip>
      ) : (
        <SortFilter type="images" />
      )}
      <MediaFiltersDropdown
        w="100%"
        filterType="images"
        hideMediaTypes={hideMediaTypes}
        hideTools={hideTools}
        unavailable={
          searchQuery
            ? {
                title: 'Not available while searching',
                reason: IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
                keys: imageFeedSearchUnavailableKeys,
                labels: imageFeedFilterLabels,
              }
            : undefined
        }
        isFeed
        size="compact-sm"
      />
    </Group>
  );
}
