import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { createContext, useContext, useMemo } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';

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

export default function ImagesAsPostsInfinite({
  columnWidth = 300,
  modelId,
  username,
}: ImagesAsPostsInfiniteProps) {
  const globalFilters = useImageFilters();
  const filters = useMemo(
    () => removeEmpty({ ...globalFilters, modelId, username, limit: 50 }),
    [globalFilters, modelId, username]
  );
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(
      { ...filters },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
      }
    );

  const items = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  return (
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
    </ImagesAsPostsInfiniteContext.Provider>
  );
}
