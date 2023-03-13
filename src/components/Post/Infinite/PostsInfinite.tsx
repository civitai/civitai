import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { trpc } from '~/utils/trpc';
import { useMemo } from 'react';

export default function PostsInfinite({ columnWidth = 300 }: { columnWidth?: number }) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.post.getInfinite.useInfiniteQuery(
      {},
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
        trpc: { context: { skipBatch: true } },
      }
    );

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
      />
    </>
  );
}
