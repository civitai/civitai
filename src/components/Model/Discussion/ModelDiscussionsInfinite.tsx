import { Button, Center, Grid, LoadingOverlay, Paper, Stack, Text, Loader } from '@mantine/core';
import React, { useMemo } from 'react';
import { InView } from 'react-intersection-observer';

import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { ReviewDiscussionItem } from '~/components/Model/ModelDiscussion/ReviewDiscussionItem';
import { CommentV2Sort, ReviewSort } from '~/server/common/enums';
import { GetCommentsV2Input } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';
import { ModelDiscussionsCard } from './ModelDiscussionsCard';
import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { createContext, useContext } from 'react';

type ModelDiscussionInfiniteState = {
  modelUserId?: number;
};
const ModelDiscussionInfiniteContext = createContext<ModelDiscussionInfiniteState | null>(null);
export const useModelDiscussionInfiniteContext = () => {
  const context = useContext(ModelDiscussionInfiniteContext);
  if (!context) throw new Error('ModelDiscussionInfiniteContext not in tree');
  return context;
};

export function ModelDiscussionsInfinite({
  modelId,
  modelUserId,
  limit,
  columnWidth = 300,
}: {
  modelId: number;
  modelUserId?: number;
  limit?: number;
  columnWidth?: number;
}) {
  const filters: Omit<GetCommentsV2Input, 'limit'> & { limit?: number } = {
    entityType: 'model',
    entityId: modelId,
    limit,
    sort: CommentV2Sort.Newest,
  };

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.commentv2.getInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
    });

  const items = useMemo(() => data?.pages.flatMap((x) => x.comments) ?? [], [data]);

  return (
    <Paper sx={(theme) => ({ position: 'relative', minHeight: 200 })}>
      <ModelDiscussionInfiniteContext.Provider value={{ modelUserId }}>
        {isLoading ? (
          <LoadingOverlay visible />
        ) : !data ? (
          <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Stack>
              <Text size="xl">There are no comments for this model yet.</Text>
              <Text color="dimmed">Start the discussion</Text>
            </Stack>
          </Paper>
        ) : (
          <MasonryGrid2
            data={items}
            hasNextPage={hasNextPage}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            fetchNextPage={fetchNextPage}
            columnWidth={columnWidth}
            render={ModelDiscussionsCard}
            filters={filters}
            autoFetch={false}
          />
        )}
      </ModelDiscussionInfiniteContext.Provider>
    </Paper>
  );
}
