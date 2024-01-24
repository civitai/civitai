import { Group, GroupProps } from '@mantine/core';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { SortFilter } from '../SortFilter';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import { ViewToggle } from '../ViewToggle';
import { useImageFilters } from '~/components/Image/image.utils';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

export function ImageFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();
  const { hidden } = useImageFilters('images');

  const canToggleView = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && !hidden;
  const currentUser = useCurrentUser();
  const canViewNewest = currentUser?.showNsfw ?? false;

  const mobile = useContainerSmallerThan('sm');

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="images" variant="button" includeNewest={canViewNewest} />
      <ImageFiltersDropdown size={mobile ? 'sm' : 'xs'} compact />
      {canToggleView && (
        <ViewToggle
          type="images"
          color="gray"
          radius="xl"
          size="sm"
          iconSize={mobile ? 16 : 14}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        />
      )}
    </Group>
  );
}
