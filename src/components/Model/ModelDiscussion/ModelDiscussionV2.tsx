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

export function ModelDiscussionV2({
  modelId,
  modelUserId,
  limit: initialLimit = 8,
  onlyHidden,
}: Props) {
  const isMobile = useContainerSmallerThan('sm');
  const limit = isMobile ? initialLimit / 2 : initialLimit;
  const filters = { modelId, limit, sort: ReviewSort.Newest, hidden: onlyHidden };

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

  const { data: hiddenCommentsCount = 0 } = trpc.comment.getVisibleCountByModel.useQuery(
    {
      modelId,
      hidden: true,
    },
    { enabled: !onlyHidden }
  );
  const hasHiddenComments = hiddenCommentsCount > 0;

  const { data: loadedTotal } = trpc.comment.getVisibleCountByModel.useQuery({
    modelId,
    hidden: onlyHidden,
  });
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
            {hasHiddenComments && !onlyHidden && (
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
  onlyHidden?: boolean;
};
