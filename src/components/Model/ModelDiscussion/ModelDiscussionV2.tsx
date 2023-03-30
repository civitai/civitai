import { Button, Grid, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import React, { useMemo, useState } from 'react';

import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ReviewSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function ModelDiscussionV2({ modelId, limit: initialLimit = 8 }: Props) {
  const isMobile = useIsMobile();
  const [limit] = useState(isMobile ? initialLimit / 2 : initialLimit);
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isRefetching } =
    trpc.comment.getAll.useInfiniteQuery(
      { modelId, limit: limit, sort: ReviewSort.Newest },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: false,
      }
    );
  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments) ?? [], [data?.pages]);
  const hasItems = comments.length > 0;

  return (
    <Grid gutter="xl">
      <Grid.Col span={12} sx={{ position: 'relative' }}>
        <LoadingOverlay visible={isLoading} zIndex={10} />
        {hasItems ? (
          <MasonryGrid
            items={comments}
            render={CommentDiscussionItem}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
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
      {/* At the bottom to detect infinite scroll */}
      {hasNextPage ? (
        <Grid.Col span={12}>
          <Button
            variant="subtle"
            fullWidth
            onClick={() => (hasNextPage ? fetchNextPage() : null)}
            loading={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading more...' : 'Load More'}
          </Button>
        </Grid.Col>
      ) : null}
    </Grid>
  );
}

type Props = {
  modelId: number;
  limit?: number;
  // filters: { filterBy: ReviewFilter[]; sort: ReviewSort };
};
