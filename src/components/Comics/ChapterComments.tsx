import { Button, Center, Group, Loader, Stack, Text, Textarea } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Comment } from '~/components/CommentsV2/Comment/Comment';
import {
  CommentsCtx,
  RootThreadCtx,
  useNewCommentStore,
} from '~/components/CommentsV2/CommentsProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ThreadSort } from '~/server/common/enums';
import { queryClient, trpc } from '~/utils/trpc';

export function ChapterComments({
  projectId,
  chapterPosition,
  userId,
}: {
  projectId: number;
  chapterPosition: number;
  userId: number;
}) {
  const currentUser = useCurrentUser();
  const [sort, setSort] = useState<ThreadSort>(ThreadSort.Oldest);
  const expanded = useNewCommentStore((state) => state.expandedComments);
  const toggleExpanded = useNewCommentStore((state) => state.toggleExpanded);
  const utils = trpc.useUtils();

  const { data: thread, isLoading } = trpc.comics.getChapterThread.useQuery(
    { projectId, chapterPosition },
    { enabled: projectId > 0 }
  );

  // Refetch comic thread data when commentv2 mutations succeed (delete, hide, pin)
  useEffect(() => {
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const mutationKey = event.mutation.options.mutationKey;
      if (!mutationKey) return;
      const keyStr = JSON.stringify(mutationKey);
      if (
        keyStr.includes('commentv2') &&
        (keyStr.includes('delete') ||
          keyStr.includes('toggleHide') ||
          keyStr.includes('togglePinned'))
      ) {
        utils.comics.getChapterThread.invalidate({ projectId, chapterPosition });
      }
    });
    return unsubscribe;
  }, [projectId, chapterPosition, utils]);

  const comments = thread?.comments ?? [];
  const commentCount = comments.length;
  const isLocked = thread?.locked ?? false;

  const setRootThread = useCallback(() => {}, []);
  const setInitialThread = useCallback(() => {}, []);

  return (
    <RootThreadCtx.Provider
      value={{
        sort,
        setSort,
        isInitialThread: true,
        setInitialThread,
        setRootThread,
        expanded,
        toggleExpanded,
        activeComment: undefined,
      }}
    >
      <CommentsCtx.Provider
        value={{
          entityType: 'comicChapter',
          entityId: thread?.id ?? 0,
          data: comments,
          isLoading,
          isFetching: false,
          isFetchingNextPage: false,
          isLocked,
          isMuted: currentUser?.muted ?? false,
          isReadonly: false,
          created: [],
          badges: [{ userId, label: 'op', color: 'violet' }],
          showMore: false,
          toggleShowMore: () => {},
          highlighted: undefined,
          hiddenCount: 0,
          forceLocked: undefined,
          sort,
          setSort,
          level: 1,
          parentThreadId: thread?.id,
        }}
      >
        <Stack>
          <Text fw={500} size="md">
            Comments {commentCount > 0 ? `(${commentCount})` : ''}
          </Text>

          {isLoading ? (
            <Center>
              <Loader type="bars" />
            </Center>
          ) : (
            <>
              {isLocked ? (
                <Text size="sm" c="dimmed">
                  Comments are locked for this chapter.
                </Text>
              ) : currentUser ? (
                <ComicCreateComment
                  projectId={projectId}
                  chapterPosition={chapterPosition}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  <Link href="/login" className="text-blue-400 hover:underline">
                    Sign in
                  </Link>{' '}
                  to leave a comment.
                </Text>
              )}

              {comments.length === 0 && !isLoading ? (
                <Text size="sm" c="dimmed">
                  No comments yet. Be the first!
                </Text>
              ) : (
                <Stack gap="xl">
                  {comments.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                  ))}
                </Stack>
              )}
            </>
          )}
        </Stack>
      </CommentsCtx.Provider>
    </RootThreadCtx.Provider>
  );
}

function ComicCreateComment({
  projectId,
  chapterPosition,
}: {
  projectId: number;
  chapterPosition: number;
}) {
  const currentUser = useCurrentUser();
  const [comment, setComment] = useState('');

  const utils = trpc.useUtils();
  const createComment = trpc.comics.createChapterComment.useMutation({
    onSuccess: () => {
      setComment('');
      utils.comics.getChapterThread.invalidate({ projectId, chapterPosition });
    },
  });

  const handleSubmit = () => {
    if (!comment.trim()) return;
    createComment.mutate({ projectId, chapterPosition, content: comment.trim() });
  };

  return (
    <Group align="flex-start" wrap="nowrap" gap="sm">
      <UserAvatar user={currentUser} size="md" />
      <Textarea
        placeholder="Type your comment..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="flex-1"
        size="sm"
        autosize
        maxRows={4}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            handleSubmit();
          }
        }}
      />
      <Button
        onClick={handleSubmit}
        loading={createComment.isPending}
        disabled={!comment.trim()}
        size="sm"
        variant="filled"
      >
        <IconSend size={16} />
      </Button>
    </Group>
  );
}
