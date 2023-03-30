import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { createContext, useContext, useMemo, useState } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import { Paper, Stack, Text, LoadingOverlay } from '@mantine/core';
import { useIsMobile } from '~/hooks/useIsMobile';
import { InView, useInView } from 'react-intersection-observer';

type ImagesAsPostsInfiniteState = {
  modelId?: number;
  username?: string;
};
const ImagesAsPostsInfiniteContext = createContext<ImagesAsPostsInfiniteState | null>(null);
export const useImagesAsPostsInfiniteContext = () => {
  const context = useContext(ImagesAsPostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesAsPostsInfiniteProps = ImagesAsPostsInfiniteState & { columnWidth?: number };

const LIMIT = 50;
export default function ImagesAsPostsInfinite({
  columnWidth = 300,
  modelId,
  username,
}: ImagesAsPostsInfiniteProps) {
  const { ref, inView } = useInView({ triggerOnce: true });
  const isMobile = useIsMobile();
  const globalFilters = useImageFilters();
  const [limit] = useState(isMobile ? LIMIT / 2 : LIMIT);
  const filters = useMemo(
    () => removeEmpty({ ...globalFilters, modelId, username, limit }),
    [globalFilters, modelId, username, limit]
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(
      { ...filters },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
        enabled: inView,
      }
    );

  const items = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return (
    <div ref={ref}>
      {inView ? (
        <ImagesAsPostsInfiniteContext.Provider value={{ modelId, username }}>
          <MasonryGrid2
            data={items}
            hasNextPage={hasNextPage}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            fetchNextPage={fetchNextPage}
            columnWidth={columnWidth}
            render={ImagesAsPostsCard}
            filters={filters}
          />
          {isLoading && (
            <Paper style={{ minHeight: 200, position: 'relative' }}>
              <LoadingOverlay visible zIndex={10} />
            </Paper>
          )}
          {!isLoading && !items.length && (
            <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Stack>
                <Text size="xl">There are no images for this model yet.</Text>
                <Text color="dimmed">
                  Add a post to showcase your images generated from this model.
                </Text>
              </Stack>
            </Paper>
          )}
        </ImagesAsPostsInfiniteContext.Provider>
      ) : (
        <div style={{ height: 200 }} />
      )}
    </div>
  );
}
