import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { trpc } from '~/utils/trpc';
import { createContext, useMemo, useContext, useEffect } from 'react';
import { useRouter } from 'next/router';
import { Alert, Center, Loader, LoadingOverlay, Stack, ThemeIcon, Text } from '@mantine/core';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { useInView } from 'react-intersection-observer';
import { usePostFilters, useQueryPosts } from '~/components/Post/post.utils';
import { IconCloudOff } from '@tabler/icons';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';

type PostsInfiniteState = {
  modelId?: number; // not hooked up to service/schema yet
  modelVersionId?: number; // not hooked up to service/schema yet
  tags?: number[];
  username?: string;
};
const PostsInfiniteContext = createContext<PostsInfiniteState | null>(null);
export const usePostsInfiniteState = () => {
  const context = useContext(PostsInfiniteContext);
  if (!context) throw new Error('PostsInfiniteContext not in tree');
  return context;
};

type PostsInfiniteProps = {
  filters?: PostsInfiniteState;
};

export default function PostsInfinite({ filters: filterOverrides = {} }: PostsInfiniteProps) {
  const { ref, inView } = useInView();
  const postFilters = usePostFilters();
  const filters = removeEmpty({ ...postFilters, ...filterOverrides });

  const { posts, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryPosts(filters, {
    keepPreviousData: true,
  });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView) fetchNextPage?.();
  }, [fetchNextPage, inView]);
  // #endregion

  return (
    <PostsInfiniteContext.Provider value={filters}>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!posts.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryColumns
            data={posts}
            imageDimensions={(data) => {
              const width = data?.image.width ?? 450;
              const height = data?.image.height ?? 450;
              return { width, height };
            }}
            maxItemHeight={600}
            render={PostsCard}
            itemId={(data) => data.id}
          />
          {hasNextPage && !isLoading && !isRefetching && (
            <Center ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
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
    </PostsInfiniteContext.Provider>
  );
}
