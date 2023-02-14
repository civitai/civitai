import { Center, Container, Group, Loader, Stack } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import {
  GalleryFilters,
  GalleryPeriod,
  GallerySort,
  useGalleryFilters,
} from '~/components/Gallery/GalleryFilters';
import { InfiniteGalleryGrid } from '~/components/Gallery/InfiniteGalleryGrid';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export default function Gallery() {
  const filters = useGalleryFilters();
  const { ref, inView } = useInView();
  const { gallery } = useFeatureFlags();

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });
  const images = useMemo(
    () => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [],
    [data?.pages]
  );

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
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
          </Group>
        </Group>
        {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : (
          <InfiniteGalleryGrid data={images} filters={filters} columnWidth={300} />
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
