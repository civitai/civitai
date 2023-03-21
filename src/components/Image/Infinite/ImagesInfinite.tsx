import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { trpc } from '~/utils/trpc';
import { useMemo } from 'react';
import { useImageFilters } from '~/providers/FiltersProvider';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';

export default function ImagesInfinite({ columnWidth = 300 }: { columnWidth?: number }) {
  const filters = useImageFilters();
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
    <>
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
    </>
  );
}
