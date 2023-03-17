import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { trpc } from '~/utils/trpc';
import { useMemo, useEffect } from 'react';
import { usePostFilters } from '~/providers/FiltersProvider';
import { useRouter } from 'next/router';

export default function PostsInfinite({ columnWidth = 300 }: { columnWidth?: number }) {
  const router = useRouter();
  const postId = router.query.post ? Number(router.query.post) : undefined;
  const filters = usePostFilters();
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.post.getInfinite.useInfiniteQuery(
      { ...filters },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
      }
    );

  // useEffect(() => console.log({ data }), [data]);
  // useEffect(() => console.log({ filters }), [filters]);
  // useEffect(() => console.log({ isLoading }), [isLoading]);
  // useEffect(() => console.log({ isFetchingNextPage }), [isFetchingNextPage]);
  // useEffect(() => console.log({ isRefetching }), [isRefetching]);

  const posts = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  return (
    <>
      <MasonryGrid2
        data={posts}
        hasNextPage={hasNextPage}
        isRefetching={isRefetching}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
        columnWidth={columnWidth}
        render={PostsCard}
        filters={filters}
        scrollToIndex={(data) => data.findIndex((x) => x.id === postId)}
      />
    </>
  );
}
