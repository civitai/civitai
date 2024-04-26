import { Group, GroupProps, Chip } from '@mantine/core';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';
import { useFiltersContext } from '~/providers/FiltersProvider';

export function ImageFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.images,
    setFilters: state.setImageFilters,
  }));
  const currentUser = useCurrentUser();
  const canViewNewest = currentUser?.showNsfw ?? false;

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
