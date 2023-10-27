import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';

import { Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';

import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { ResourceReviewCard } from '~/components/ResourceReview/ResourceReviewCard';

// TODO.Briant - determine if this is needed, along with trpc.resourceReview.getInfinite
export function ResourceReviewGrid({
  modelId,
  limit = 8,
  columnWidth = 300,
}: {
  modelId: number;
  columnWidth?: number;
  limit?: number;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.resourceReview.getInfinite.useInfiniteQuery(
      { modelId, limit },
      {
        getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
        getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      }
    );

  const resourceReviews = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return (
    <>
      {isLoading ? (
        <Center>
          <Loader size="xl" />
        </Center>
      ) : !!resourceReviews.length ? (
        <MasonryGrid2
          columnWidth={columnWidth}
          data={resourceReviews}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isRefetching={isRefetching}
          fetchNextPage={fetchNextPage}
          render={ResourceReviewCard}
          filters={{ modelId, limit }}
          autoFetch={false}
        />
      ) : (
        <Stack align="center">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text size={32} align="center">
            No results found
          </Text>
        </Stack>
      )}
    </>
  );
}
