import { Stack, Text, LoadingOverlay, Center, Loader, ThemeIcon } from '@mantine/core';
import { createContext, useContext, useEffect } from 'react';

import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { removeEmpty } from '~/utils/object-helpers';
import { ImageSort } from '~/server/common/enums';
import { useImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { useInView } from 'react-intersection-observer';
import { IconCloudOff } from '@tabler/icons-react';
import { MetricTimeframe, ReviewReactions } from '@prisma/client';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { IsClient } from '~/components/IsClient/IsClient';

type ImagesInfiniteState = {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  collectionId?: number;
  username?: string;
  reviewId?: number;
  prioritizedUserIds?: number[];
  period?: MetricTimeframe;
  sort?: ImageSort;
  reactions?: ReviewReactions[];
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
  showEof?: boolean;
};

export default function ImagesInfinite({
  withTags,
  filters: filterOverrides = {},
  showEof = false,
}: ImagesInfiniteProps) {
  const { ref, inView } = useInView();
  const imageFilters = useImageFilters('images');
  const filters = removeEmpty({ ...imageFilters, ...filterOverrides, withTags });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;

  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryImages(filters, {
      keepPreviousData: true,
    });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && !isFetching) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView, isFetching]);
  // #endregion

  return (
    <IsClient>
      <ImagesInfiniteContext.Provider value={filters}>
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
            {!hasNextPage && showEof && <EndOfFeed />}
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
    </IsClient>
  );
}
