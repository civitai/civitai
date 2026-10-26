import { Group, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import { LoadMoreButton } from '~/components/LoadMoreButton/LoadMoreButton';
import { IconMessageCancel } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';

import { CommentMasonryVirtual } from '~/components/Model/ModelDiscussion/CommentMasonryVirtual';
import { ReviewSort } from '~/server/common/enums';
import type { CommentGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ModelDiscussionV2({ modelId, modelUserId, limit: initialLimit = 8 }: Props) {
  const isMobile = useContainerSmallerThan('sm');
  const features = useFeatureFlags();
  const singleCall = !!features.commentCountsSingleCall;
  const limit = isMobile ? initialLimit / 2 : initialLimit;
  const filters = { modelId, limit, sort: ReviewSort.Newest };

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isRefetching } =
    trpc.comment.getAll.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      placeholderData: undefined,
    });
  const comments = useMemo(() => {
    const byId = new Map<number, CommentGetAllItem>();
    for (const comment of data?.pages.flatMap((x) => x.comments) ?? [])
      if (!byId.has(comment.id)) byId.set(comment.id, comment);
    return [...byId.values()];
  }, [data?.pages]);
  const hasItems = comments.length > 0;

  // `commentCountsSingleCall` off: the plain and the hidden view's counts as two calls, as before.
  const { data: singleHiddenCount = 0 } = trpc.comment.getVisibleCountByModel.useQuery(
    { modelId, hidden: true },
    { enabled: !singleCall }
  );
  const { data: singleVisibleCount } = trpc.comment.getVisibleCountByModel.useQuery(
    { modelId },
    { enabled: true } // N2
  );

  // On: one call, once the first page is in, and only when there is a list to label (both counts
  // render inside it). When the first page has no next page it holds every comment the visible
  // count counts (the whole unpinned list and the pinned block, same viewer filter), so that count
  // is the loaded total and is not asked for.
  const firstPage = data?.pages[0];
  const firstPageHoldsAll = !!firstPage && firstPage.nextCursor === undefined;
  const { data: counts } = trpc.comment.getVisibleCountsByModel.useQuery(
    { modelId, includeVisible: true }, // N1
    { enabled: singleCall && hasItems }
  );

  const hiddenCommentsCount = singleCall ? counts?.hidden ?? 0 : singleHiddenCount;
  const hasHiddenComments = hiddenCommentsCount > 0;
  const loadedTotal = singleCall
    ? firstPageHoldsAll
      ? comments.length
      : counts?.visible ?? undefined
    : singleVisibleCount;
  const totalCount = Math.max(loadedTotal ?? 0, comments.length);
  // Without the total, the loaded count alone would read as the full count beside Load more.
  const countLabel =
    loadedTotal === undefined
      ? null
      : totalCount > comments.length
      ? `Showing ${comments.length} of ${totalCount} comments`
      : totalCount > 0
      ? `${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}`
      : null;

  return (
    <ContainerGrid2 gutter="xl">
      <ContainerGrid2.Col span={12} style={{ position: 'relative' }}>
        <LoadingOverlay visible={isLoading} zIndex={10} />
        {hasItems ? (
          <Stack gap={8}>
            <div style={{ position: 'relative' }}>
              <LoadingOverlay visible={isRefetching && !isFetchingNextPage} zIndex={9} />
              <CommentMasonryVirtual comments={comments} modelUserId={modelUserId} />
            </div>
            <Stack gap={8} align="center">
              {hasNextPage && (
                <LoadMoreButton onClick={fetchNextPage} loading={isFetchingNextPage} />
              )}
              {countLabel && (
                <Text size="xs" c="dimmed">
                  {countLabel}
                </Text>
              )}
            </Stack>
            {hasHiddenComments && (
              <RoutedDialogLink
                name="hiddenComments"
                state={{ entityId: modelId, entityType: 'model' }}
                style={{ display: 'flex', justifyContent: 'center', alignSelf: 'center' }}
              >
                <Group gap={4} justify="center">
                  <IconMessageCancel size={16} />
                  <Text size="xs" c="dimmed" inline>
                    {`See ${hiddenCommentsCount} more hidden ${
                      hiddenCommentsCount > 1 ? 'comments' : 'comment'
                    }`}
                  </Text>
                </Group>
              </RoutedDialogLink>
            )}
          </Stack>
        ) : (
          <Paper
            p="xl"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 200,
            }}
          >
            <Stack>
              <Text size="xl">There are no comments for this model yet.</Text>
              <Text c="dimmed">
                Be the first to let the people know about this model by leaving your comment.
              </Text>
            </Stack>
          </Paper>
        )}
      </ContainerGrid2.Col>
    </ContainerGrid2>
  );
}

type Props = {
  modelId: number;
  modelUserId?: number;
  limit?: number;
};
