import { Group, GroupProps } from '@mantine/core';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';

export function ImageFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  const currentUser = useCurrentUser();
  const canViewNewest = currentUser?.showNsfw ?? false;

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="images"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter
        type="images"
        variant="button"
        includeNewest={canViewNewest}
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <ImageFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} isFeed />
    </Group>
  );
}
