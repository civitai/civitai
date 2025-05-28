import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';

export function ImageFeedFilters({
  hideMediaTypes,
  hideTools,
  ...groupProps
}: GroupProps & { hideMediaTypes?: boolean; hideTools?: boolean }) {
  const { classes } = useFeedFiltersStyles();

  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="images"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter type="images" className={classes.subnavDropdown} />
      <MediaFiltersDropdown
        size="sm"
        w="100%"
        className={classes.subnavDropdown}
        filterType="images"
        hideMediaTypes={hideMediaTypes}
        hideTools={hideTools}
        isFeed
        compact
      />
    </Group>
  );
}
