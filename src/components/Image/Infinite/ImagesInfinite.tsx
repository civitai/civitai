import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { createContext, useContext, useMemo } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { Paper, Stack, Text } from '@mantine/core';

type ImagesInfiniteState = {
  modelId?: number;
  postId?: number;
  username?: string;
  reviewId?: number;
  prioritizedUserIds?: number[];
};
const ImagesInfiniteContext = createContext<ImagesInfiniteState | null>(null);
export const useImagesInfiniteContext = () => {
  const context = useContext(ImagesInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesInfiniteProps = ImagesInfiniteState & { columnWidth?: number };

export default function ImagesInfinite({
  columnWidth = 300,
  modelId,
  postId,
  username,
  reviewId,
  prioritizedUserIds,
}: ImagesInfiniteProps) {
  const globalFilters = useImageFilters();
  const filters = useMemo(
    () =>
      removeEmpty({ ...globalFilters, modelId, postId, username, reviewId, prioritizedUserIds }),
    [globalFilters, modelId, postId, username, reviewId, prioritizedUserIds]
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getInfinite.useInfiniteQuery(
      { ...filters },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
      }
    );

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return (
    <ImagesInfiniteContext.Provider value={{ modelId, postId, username }}>
      <MasonryGrid2
        data={images}
        hasNextPage={hasNextPage}
        isRefetching={isRefetching}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
        columnWidth={columnWidth}
        render={ImagesCard}
        filters={filters}
      />
      {!isLoading && !images.length && (
        <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Stack>
            <Text size="xl">There are no images for this model yet.</Text>
            <Text color="dimmed">
              Add a post to showcase your images generated from this model.
            </Text>
          </Stack>
        </Paper>
      )}
    </ImagesInfiniteContext.Provider>
  );
}
