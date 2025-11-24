import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconCloudOff } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import React, { useEffect } from 'react';

import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { FeedWrapper } from '~/components/Feed/FeedWrapper';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { PostsCardMemoized } from '~/components/Post/Infinite/PostsCard';
import { usePostFilters, useQueryPosts } from '~/components/Post/post.utils';
import type { PostSort } from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

export type PostsInfiniteState = {
  modelId?: number; // not hooked up to service/schema yet
  modelVersionId?: number; // not hooked up to service/schema yet
  tags?: number[];
  username?: string | null;
  period?: MetricTimeframe;
  sort?: PostSort;
  collectionId?: number;
  draftOnly?: boolean;
  followed?: boolean;
  pending?: boolean;
};

type PostsInfiniteProps = {
  filters?: PostsInfiniteState;
  showEof?: boolean;
  showAds?: boolean;
  disableStoreFilters?: boolean;
};

export default function PostsInfinite(props: PostsInfiniteProps) {
  return (
    <FeedWrapper>
      <PostsInfiniteContent {...props} />
    </FeedWrapper>
  );
}

function PostsInfiniteContent({
  filters: filterOverrides = {},
  showEof = false,
  showAds,
  disableStoreFilters,
}: PostsInfiniteProps) {
  const postFilters = usePostFilters();
  const filters = disableStoreFilters
    ? filterOverrides
    : removeEmpty({ ...postFilters, ...filterOverrides });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { posts, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryPosts(
    debouncedFilters,
    { keepPreviousData: true }
  );

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
          <MasonryColumnsVirtual
            data={posts}
            imageDimensions={(data) => {
              const image = data.images[0];
              const width = image.width ?? 450;
              const height = image.height ?? 450;
              return { width, height };
            }}
            maxItemHeight={600}
            render={PostsCardMemoized}
            itemId={(data) => data.id}
            withAds={showAds}
          />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <Stack align="center" py="lg">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text fz={32} align="center">
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
