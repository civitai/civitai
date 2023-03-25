import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { createContext, useContext, useMemo } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { ImageSort } from '~/server/common/enums';

type ImagesInfiniteState = {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  username?: string;
  reviewId?: number;
  withTags?: boolean;
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
  modelVersionId,
  postId,
  username,
  reviewId,
  withTags,
}: ImagesInfiniteProps) {
  const globalFilters = useImageFilters();
  const filters = useMemo(() => {
    const baseFilters = { postId, modelId, modelVersionId, username, withTags };
    return removeEmpty(
      !postId && !modelVersionId && !reviewId ? { ...baseFilters, ...globalFilters } : baseFilters
    );
  }, [globalFilters, postId, modelId, modelVersionId, username, reviewId, withTags]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
    });

  const images = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  return (
    <ImagesInfiniteContext.Provider value={{ modelId, modelVersionId, postId, username }}>
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
