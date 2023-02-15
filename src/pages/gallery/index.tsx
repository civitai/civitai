import { ActionIcon, Center, Container, Group, Loader, Stack } from '@mantine/core';
import { IconFilterOff } from '@tabler/icons';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import {
  GalleryCategories,
  GalleryFilters,
  GalleryPeriod,
  GallerySort,
  useGalleryFilters,
} from '~/components/Gallery/GalleryFilters';
import { InfiniteGalleryGrid } from '~/components/Gallery/InfiniteGalleryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export default function Gallery() {
  const { filters, clearFilters } = useGalleryFilters();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView();
  const { gallery } = useFeatureFlags();

  const { data: blockedTags } = trpc.user.getTags.useQuery(
    { type: 'Hide' },
    { enabled: !!currentUser, cacheTime: Infinity, staleTime: Infinity }
  );
  const excludedTagIds = blockedTags?.map((tag) => tag.id);

  const { data: hidden = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const excludedUserIds = useMemo(() => hidden.map((item) => item.id), [hidden]);

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { ...filters, excludedTagIds, excludedUserIds },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );
  const images = useMemo(
    () => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [],
    [data?.pages]
  );

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  if (!gallery) return null;

  return (
    <Container size={1920}>
      <Stack>
        <Group position="apart">
          <GallerySort />
          <Group spacing={4}>
            <GalleryPeriod />
            <GalleryFilters />
            {!!filters.tags?.length ? (
              <ActionIcon variant="subtle" color="red" size="md" onClick={clearFilters}>
                <IconFilterOff size={20} />
              </ActionIcon>
            ) : null}
          </Group>
        </Group>
        <GalleryCategories />
        {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : images.length ? (
          <InfiniteGalleryGrid data={images} filters={filters} columnWidth={300} />
        ) : (
          <NoContent />
        )}
        {!isLoading && hasNextPage && (
          <Group position="center" ref={ref}>
            <Loader />
          </Group>
        )}
      </Stack>
    </Container>
  );
}
