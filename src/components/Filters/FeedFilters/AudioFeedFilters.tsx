import { Group, GroupProps } from '@mantine/core';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { AudioFiltersDropdown } from '~/components/Image/Filters/AudioFiltersDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function AudioFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();
  const currentUser = useCurrentUser();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      {currentUser && (
        <FollowedFilter
          type="audio"
          variant="button"
          buttonProps={{ className: classes.subnavDropdown }}
        />
      )}
      <SortFilter
        type="audio"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <AudioFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} isFeed />
    </Group>
  );
}
