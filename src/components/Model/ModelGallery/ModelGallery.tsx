import { ActionIcon, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
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
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { trpc } from '~/utils/trpc';

export function ModelGallery({ modelId, limit = DEFAULT_PAGE_SIZE }: Props) {
  const { filters, clearFilters } = useGalleryFilters();
  const { ref, inView } = useInView();

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { ...filters, limit, modelId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const images = useMemo(
    () => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [],
    [data?.pages]
  );

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  return (
    <Stack spacing="xs">
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
        <Center>
          <Loader size="lg" />
        </Center>
      ) : images.length ? (
        <InfiniteGalleryGrid data={images} filters={filters} columnWidth={300} />
      ) : (
        <Paper
          p="xl"
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}
        >
          <Stack>
            <Text size="xl">There are no images for this model yet.</Text>
            <Text color="dimmed">
              Be the first to share your creation with this model by adding a post.
            </Text>
          </Stack>
        </Paper>
      )}
      {!isLoading && hasNextPage && (
        <Group position="center" ref={ref}>
          <Loader />
        </Group>
      )}
    </Stack>
  );
}

type Props = {
  modelId: number;
  limit?: number;
};
