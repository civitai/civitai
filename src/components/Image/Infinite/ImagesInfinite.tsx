import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { createContext, useContext, useMemo } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';

type ImagesInfiniteState = {
  modelId?: number;
  postId?: number;
  username?: string;
  reviewId?: number;
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
}: ImagesInfiniteProps) {
  const globalFilters = useImageFilters();
  const filters = useMemo(
    () => removeEmpty({ ...globalFilters, modelId, postId, username, reviewId }),
    [globalFilters, modelId, postId, username, reviewId]
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

  const images = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

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
    </ImagesInfiniteContext.Provider>
  );
}
