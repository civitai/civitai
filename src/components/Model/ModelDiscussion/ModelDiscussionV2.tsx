import { Alert, Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconMessageCancel } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { useCommentSection } from '~/components/CommentsV3/CommentSectionContext';
import type { CommentV3Comment } from '~/components/CommentsV3/types';
import { LoadMoreButton } from '~/components/LoadMoreButton/LoadMoreButton';
import { CommentMasonryVirtual } from '~/components/Model/ModelDiscussion/CommentMasonryVirtual';

export function ModelDiscussionV2({ modelUserId }: Props) {
  const {
    entityId,
    counts,
    rootIds,
    byId,
    created,
    removed,
    isLoading,
    isError,
    retry,
    hasMore,
    isFetchingMore,
    loadMore,
  } = useCommentSection();

  // Comments written this session lead, as the newest; a refetch then lists them in place.
  const comments = useMemo(() => {
    const list: CommentV3Comment[] = [];
    const seen = new Set<number>();
    const push = (comment?: CommentV3Comment) => {
      if (!comment || seen.has(comment.id) || removed.has(comment.id)) return;
      seen.add(comment.id);
      list.push(comment);
    };
    for (const comment of [...(created[0] ?? [])].reverse()) push(comment);
    for (const id of rootIds) push(byId.get(id));
    return list;
  }, [rootIds, byId, created, removed]);

  const total = Math.max(counts?.visible ?? 0, comments.length);
  // Without the total, the loaded count alone would read as the full count beside Load more.
  const countLabel = !counts
    ? null
    : total > comments.length
    ? `Showing ${comments.length} of ${total} comments`
    : `${total} ${total === 1 ? 'comment' : 'comments'}`;
  const hiddenCount = counts?.hidden ?? 0;

  return (
    <ContainerGrid2 gutter="xl">
      <ContainerGrid2.Col span={12} style={{ position: 'relative' }}>
        {isLoading ? (
          <Center py="xl" mih={200}>
            <Loader type="bars" />
          </Center>
        ) : isError ? (
          <Alert color="red" classNames={{ message: 'flex items-center justify-between gap-4' }}>
            <Text size="sm">Comments could not be loaded.</Text>
            <Button size="compact-sm" variant="light" color="red" onClick={retry}>
              Try again
            </Button>
          </Alert>
        ) : comments.length > 0 ? (
          <Stack gap={8}>
            <CommentMasonryVirtual comments={comments} modelUserId={modelUserId} />
            <Stack gap={8} align="center">
              {hasMore && <LoadMoreButton onClick={loadMore} loading={isFetchingMore} />}
              {countLabel && (
                <Text size="xs" c="dimmed">
                  {countLabel}
                </Text>
              )}
            </Stack>
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
        {hiddenCount > 0 && (
          <RoutedDialogLink
            name="hiddenComments"
            state={{ modelId: entityId }}
            style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}
          >
            <Group gap={4} justify="center">
              <IconMessageCancel size={16} />
              <Text size="xs" c="dimmed" inline>
                {`See ${hiddenCount} more hidden ${hiddenCount > 1 ? 'comments' : 'comment'}`}
              </Text>
            </Group>
          </RoutedDialogLink>
        )}
      </ContainerGrid2.Col>
    </ContainerGrid2>
  );
}

type Props = { modelUserId?: number };
