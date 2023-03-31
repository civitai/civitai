import { Grid, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import React, { useMemo } from 'react';

import { MasonryGrid2 } from '~/components/MasonryGrid/MasonryGrid2';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ReviewSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function ModelDiscussionV2({ modelId, limit: initialLimit = 8 }: Props) {
  const isMobile = useIsMobile();
  const limit = isMobile ? initialLimit / 2 : initialLimit;
  const filters = { modelId, limit, sort: ReviewSort.Newest };

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isRefetching } =
    trpc.comment.getAll.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      keepPreviousData: false,
    });
  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments) ?? [], [data?.pages]);
  const hasItems = comments.length > 0;

  return (
    <Grid gutter="xl">
      <Grid.Col span={12} sx={{ position: 'relative' }}>
        <LoadingOverlay visible={isLoading} zIndex={10} />
        {hasItems ? (
          <MasonryGrid2
            data={comments}
            render={CommentDiscussionItem}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            hasNextPage={hasNextPage}
            fetchNextPage={fetchNextPage}
            filters={filters}
            columnWidth={300}
            autoFetch={false}
          />
        ) : (
          <Paper
            p="xl"
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}
          >
            <Stack>
              <Text size="xl">There are no comments for this model yet.</Text>
              <Text color="dimmed">
                Be the first to let the people know about this model by leaving your comment.
              </Text>
            </Stack>
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  );
}

type Props = {
  modelId: number;
  limit?: number;
  // filters: { filterBy: ReviewFilter[]; sort: ReviewSort };
};
