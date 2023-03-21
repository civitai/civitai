import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { trpc } from '~/utils/trpc';
import { createContext, useMemo, useContext } from 'react';
import { usePostFilters } from '~/providers/FiltersProvider';
import { useRouter } from 'next/router';
import { Alert, Center, Loader } from '@mantine/core';
import { QS } from '~/utils/qs';

type PostsInfiniteState = {
  modelId?: number; // not hooked up to service/schema yet
  modelVersionId?: number; // not hooked up to service/schema yet
  username?: string;
};
const PostsInfiniteContext = createContext<PostsInfiniteState | null>(null);
export const usePostsInfiniteState = () => {
  const context = useContext(PostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type PostsInfiniteProps = PostsInfiniteState & { columnWidth?: number };

export default function PostsInfinite({
  columnWidth = 300,
  username,
  modelId,
  modelVersionId,
}: PostsInfiniteProps) {
  const router = useRouter();
  const postId = router.query.post ? Number(router.query.post) : undefined;
  const globalFilters = usePostFilters();
  const filters = useMemo(
    () => QS.parse(QS.stringify({ ...globalFilters, username, modelId, modelVersionId })),
    [globalFilters, username, modelId, modelVersionId]
  );
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

  const posts = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);

  return (
    <PostsInfiniteContext.Provider value={{ modelId, modelVersionId, username }}>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!posts.length ? (
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
      ) : (
        <Center>
          <Alert>There are no posts to display</Alert>
        </Center>
      )}
    </PostsInfiniteContext.Provider>
  );
}
