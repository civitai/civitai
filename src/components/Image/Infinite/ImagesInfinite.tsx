import { Stack, Text, LoadingOverlay, Center, Loader, ThemeIcon } from '@mantine/core';
import { createContext, useContext, useEffect } from 'react';

import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { removeEmpty } from '~/utils/object-helpers';
import { BrowsingMode } from '~/server/common/enums';
import { useRouter } from 'next/router';
import { useQueryImages, parseImagesQuery } from '~/components/Image/image.utils';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { useInView } from 'react-intersection-observer';
import { IconCloudOff } from '@tabler/icons';

type ImagesInfiniteState = {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  username?: string;
  reviewId?: number;

  prioritizedUserIds?: number[];
  browsingMode?: BrowsingMode;
};
const ImagesInfiniteContext = createContext<ImagesInfiniteState | null>(null);
export const useImagesInfiniteContext = () => {
  const context = useContext(ImagesInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesInfiniteProps = {
  withTags?: boolean;
  filters?: ImagesInfiniteState;
};

export default function ImagesInfinite({
  withTags,
  filters: filterOverrides = {},
}: ImagesInfiniteProps) {
  const router = useRouter();
  const { ref, inView } = useInView();
  const globalFilters = useImageFilters();
  const parsedParams = parseImagesQuery(router.query);
  const baseFilters = { ...parsedParams, ...filterOverrides };
  const filters = removeEmpty({ ...baseFilters, ...globalFilters, withTags });

  const { images, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    useQueryImages(filters, { keepPreviousData: true });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView]);
  // #endregion

  return (
    <ImagesInfiniteContext.Provider value={baseFilters}>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!images.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryColumns
            data={images}
            imageDimensions={(data) => {
              const width = data?.width ?? 450;
              const height = data?.height ?? 450;
              return { width, height };
            }}
            maxItemHeight={600}
            render={ImagesCard}
            itemId={(data) => data.id}
          />
          {hasNextPage && !isLoading && !isRefetching && (
            <Center ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
        </div>
      ) : (
        <Stack align="center" py="lg">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text size={32} align="center">
            No results found
          </Text>
          <Text align="center">
            {"Try adjusting your search or filters to find what you're looking for"}
          </Text>
        </Stack>
      )}
    </ImagesInfiniteContext.Provider>
  );
}
