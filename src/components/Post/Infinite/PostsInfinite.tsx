import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { MetricTimeframe } from '@prisma/client';
import { IconCloudOff } from '@tabler/icons-react';
import { debounce, isEqual } from 'lodash-es';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { PostsCard } from '~/components/Post/Infinite/PostsCard';
import { usePostFilters, useQueryPosts } from '~/components/Post/post.utils';
import { PostSort } from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

type PostsInfiniteState = {
  modelId?: number; // not hooked up to service/schema yet
  modelVersionId?: number; // not hooked up to service/schema yet
  tags?: number[];
  username?: string;
  period?: MetricTimeframe;
  sort?: PostSort;
  collectionId?: number;
};

type PostsInfiniteProps = {
  filters?: PostsInfiniteState;
  showEof?: boolean;
};

export default function PostsInfinite({
  filters: filterOverrides = {},
  showEof = false,
}: PostsInfiniteProps) {
  const { ref, inView } = useInView();
  const postFilters = usePostFilters();
  const filters = removeEmpty({ ...postFilters, ...filterOverrides });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { posts, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } = useQueryPosts(
    debouncedFilters,
    { keepPreviousData: true }
  );
  const debouncedFetchNextPage = useMemo(() => debounce(fetchNextPage, 500), [fetchNextPage]);

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && !isFetching) debouncedFetchNextPage();
  }, [debouncedFetchNextPage, inView, isFetching]);
  // #endregion

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
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
          {!hasNextPage && showEof && <EndOfFeed />}
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
    </>
  );
}
